import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, State } from "vscode-languageclient/node";

const ZIG_LANGUAGE = "zig";

interface ZigConfig {
  zig: string;
  zls: string;
  zlsEnabled: boolean;
  diagnosticsEnabled: boolean;
  diagnosticsOnSave: boolean;
  debounceMs: number;
  formatArgs: string[];
  taskArgs: string[];
}

function config(resource?: vscode.Uri): ZigConfig {
  const get = vscode.workspace.getConfiguration("zigLangSupport", resource);
  return {
    zig: get.get<string>("zig.path", "zig"), zls: get.get<string>("zls.path", "zls"),
    zlsEnabled: get.get<boolean>("zls.enabled", true), diagnosticsEnabled: get.get<boolean>("diagnostics.enabled", true),
    diagnosticsOnSave: get.get<boolean>("diagnostics.onSave", true), debounceMs: get.get<number>("diagnostics.debounceMs", 500),
    formatArgs: get.get<string[]>("format.args", []), taskArgs: get.get<string[]>("tasks.extraArgs", [])
  };
}

function execFile(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => childProcess.execFile(command, args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
  }));
}

function formatText(command: string, args: string[], input: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `zig fmt exited with ${code}`)));
    child.stdin.end(input);
  });
}

function workspaceFolder(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return uri ? vscode.workspace.getWorkspaceFolder(uri) : vscode.workspace.workspaceFolders?.[0];
}

class CompilerDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("zig-lang-support");
  private readonly timers = new Map<string, NodeJS.Timeout>();

  public schedule(document: vscode.TextDocument): void {
    if (document.languageId !== ZIG_LANGUAGE || !config(document.uri).diagnosticsEnabled) return;
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => void this.refresh(document), config(document.uri).debounceMs));
  }

  public async refresh(document: vscode.TextDocument): Promise<void> {
    if (document.isUntitled || document.languageId !== ZIG_LANGUAGE) return;
    const folder = workspaceFolder(document.uri);
    try {
      await execFile(config(document.uri).zig, ["ast-check", document.uri.fsPath], folder?.uri.fsPath);
      this.collection.delete(document.uri);
    } catch (error) {
      const output = String((error as { stderr?: string }).stderr ?? (error as Error).message);
      this.collection.set(document.uri, parseDiagnostics(output, document));
    }
  }

  public dispose(): void { for (const timer of this.timers.values()) clearTimeout(timer); this.collection.dispose(); }
}

function parseDiagnostics(output: string, document: vscode.TextDocument): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const pattern = /^(.*?):(\d+):(\d+):\s*(error|warning|note):\s*(.*)$/gm;
  for (const match of output.matchAll(pattern)) {
    const line = Math.max(0, Number(match[2]) - 1); const column = Math.max(0, Number(match[3]) - 1);
    if (line >= document.lineCount) continue;
    const severity = match[4] === "warning" ? vscode.DiagnosticSeverity.Warning : match[4] === "note" ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Error;
    diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, column, line, document.lineAt(line).range.end.character), match[5], severity));
  }
  return diagnostics;
}

class FallbackCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(): vscode.CompletionItem[] {
    const keywords = ["const", "var", "fn", "pub", "extern", "export", "comptime", "inline", "struct", "enum", "union", "opaque", "error", "test", "defer", "errdefer", "try", "catch", "orelse", "if", "else", "switch", "while", "for", "break", "continue", "return", "unreachable"];
    const builtins = ["@import", "@This", "@TypeOf", "@typeInfo", "@as", "@intCast", "@floatCast", "@ptrCast", "@alignCast", "@memcpy", "@memset", "@sizeOf", "@bitSizeOf", "@compileError", "@panic", "@field", "@fieldParentPtr", "@embedFile", "@cImport"];
    return [...keywords.map(word => new vscode.CompletionItem(word, vscode.CompletionItemKind.Keyword)), ...builtins.map(word => {
      const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Function); item.insertText = new vscode.SnippetString(`${word}($0)`); item.detail = "Zig builtin"; return item;
    })];
  }
}

class ZigFormatter implements vscode.DocumentFormattingEditProvider {
  async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
    if (document.isUntitled) return [];
    try {
      const formatted = await formatText(config(document.uri).zig, ["fmt", "--stdin", ...config(document.uri).formatArgs], document.getText(), workspaceFolder(document.uri)?.uri.fsPath);
      return [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), formatted)];
    } catch (error) {
      void vscode.window.showErrorMessage(`Zig formatting failed: ${String((error as { stderr?: string }).stderr ?? error)}`);
      return [];
    }
  }
}

interface Dependency { name: string; url: string; start: number; end: number; }

function balancedEnd(text: string, open: number): number {
  let depth = 0; let quote = false;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "\"") {
      let backslashes = 0;
      for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) backslashes++;
      if (backslashes % 2 === 0) quote = !quote;
    }
    if (quote) continue;
    if (text[index] === "{") depth++; else if (text[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function dependencies(text: string): Dependency[] {
  const block = text.search(/\.dependencies\s*=\s*\.\s*\{/); if (block < 0) return [];
  const open = text.indexOf("{", block); const end = balancedEnd(text, open); if (end < 0) return [];
  const result: Dependency[] = []; const entry = /\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\.\s*\{/g;
  for (let match; (match = entry.exec(text)) !== null && match.index < end;) {
    if (match.index <= open) continue;
    const entryOpen = text.indexOf("{", match.index); const entryEnd = balancedEnd(text, entryOpen); if (entryEnd < 0 || entryEnd > end) continue;
    const url = /\.url\s*=\s*"([^"]+)"/.exec(text.slice(entryOpen, entryEnd + 1))?.[1] ?? "local/path dependency";
    result.push({ name: match[1], url, start: match.index, end: entryEnd }); entry.lastIndex = entryEnd + 1;
  }
  return result;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
const html = (title: string, dependenciesList: Dependency[], hasProject: boolean) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px}h2{margin-top:0}input{box-sizing:border-box;width:100%;margin:4px 0;padding:7px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}button{margin:4px 4px 4px 0;padding:6px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;cursor:pointer}.danger{background:var(--vscode-inputValidation-errorBackground)}.card{border-top:1px solid var(--vscode-panel-border);padding:9px 0}.url{font-size:11px;opacity:.75;word-break:break-all}</style></head><body>
<h2>${escapeHtml(title)}</h2>${hasProject ? `<button data-action="build">Build</button><button data-action="run">Run</button><button data-action="test">Test</button><button data-action="fetch">Fetch all</button><button data-action="restart">Restart ZLS</button><h3>Dependencies</h3><div id="dependencies">${dependenciesList.map(dep => `<div class="card"><strong>${escapeHtml(dep.name)}</strong><div class="url">${escapeHtml(dep.url)}</div><button class="danger" data-remove="${escapeHtml(dep.name)}">Remove</button></div>`).join("") || "No dependencies yet."}</div><h3>Add dependency</h3><input id="name" placeholder="Name, e.g. zqlite"><input id="url" placeholder="Package URL"><button data-action="add">Add dependency</button>` : `<p>Open a folder to manage its Zig project.</p>`}<script>const v=acquireVsCodeApi(),n=document.getElementById('name'),u=document.getElementById('url');document.addEventListener('click',e=>{const t=e.target;if(t.dataset.remove)v.postMessage({type:'remove',name:t.dataset.remove});if(t.dataset.action==='add')v.postMessage({type:'add',name:n.value,url:u.value});if(t.dataset.action&&t.dataset.action!=='add')v.postMessage({type:t.dataset.action});});</script></body></html>`;

class ProjectDashboard implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  resolveWebviewView(view: vscode.WebviewView): void { this.view = view; view.webview.options = { enableScripts: true }; view.webview.onDidReceiveMessage(message => void this.handle(message)); this.refresh(); }
  async refresh(): Promise<void> { const folder = workspaceFolder(); if (!folder || !this.view) return; const zon = vscode.Uri.joinPath(folder.uri, "build.zig.zon"); try { const text = Buffer.from(await vscode.workspace.fs.readFile(zon)).toString("utf8"); this.view.webview.html = html(folder.name, dependencies(text), true); } catch { this.view.webview.html = html(folder.name, [], false); } }
  private async handle(message: { type: string; name?: string; url?: string }): Promise<void> {
    const folder = workspaceFolder(); if (!folder) return;
    if (["build", "run", "test", "fetch", "restart"].includes(message.type)) { await vscode.commands.executeCommand(`zigLangSupport.${message.type === "restart" ? "restartLanguageServer" : message.type === "fetch" ? "fetchDependencies" : message.type}`); return; }
    if (message.type === "add") {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(message.name ?? "") || !message.url?.trim()) { void vscode.window.showErrorMessage("Enter a valid Zig dependency name and package URL."); return; }
      try { await execFile(config().zig, ["fetch", `--save=${message.name}`, message.url.trim()], folder.uri.fsPath); await this.refresh(); } catch (error) { void vscode.window.showErrorMessage(`Could not add dependency: ${String((error as { stderr?: string }).stderr ?? error)}`); }
    }
    if (message.type === "remove" && message.name) {
      const zon = vscode.Uri.joinPath(folder.uri, "build.zig.zon"); const text = Buffer.from(await vscode.workspace.fs.readFile(zon)).toString("utf8"); const dep = dependencies(text).find(item => item.name === message.name); if (!dep) return;
      let end = dep.end + 1; while (/\s/.test(text[end] ?? "")) end++; if (text[end] === ",") end++; else { let start = dep.start; while (start > 0 && /\s/.test(text[start - 1])) start--; await vscode.workspace.fs.writeFile(zon, Buffer.from(text.slice(0, start) + text.slice(end))); await this.refresh(); return; }
      await vscode.workspace.fs.writeFile(zon, Buffer.from(text.slice(0, dep.start) + text.slice(end))); await this.refresh();
    }
  }
}

let client: LanguageClient | undefined;

async function startLanguageServer(context: vscode.ExtensionContext): Promise<void> {
  if (!config().zlsEnabled || client?.state === State.Running) return;
  const folder = workspaceFolder();
  const bundledZls = vscode.Uri.joinPath(context.extensionUri, "server", `${process.platform}-${process.arch}`, process.platform === "win32" ? "zls.exe" : "zls").fsPath;
  const zlsCommand = config().zls === "zls" && fs.existsSync(bundledZls) ? bundledZls : config().zls;
  try {
    await execFile(zlsCommand, ["--version"], folder?.uri.fsPath);
  } catch {
    return;
  }
  const serverOptions: ServerOptions = { command: zlsCommand, args: [], options: { cwd: folder?.uri.fsPath } };
  const clientOptions: LanguageClientOptions = { documentSelector: [{ language: ZIG_LANGUAGE, scheme: "file" }], synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{zig,zon}") }, outputChannelName: "Zig-Lang-Support Language Server" };
  client = new LanguageClient("zigLangSupport.zls", "Zig-Lang-Support Language Server", serverOptions, clientOptions);
  context.subscriptions.push(client);
  try { await client.start(); } catch { client = undefined; }
}

function runTask(name: string, args: string[], resource?: vscode.Uri): void {
  const folder = workspaceFolder(resource);
  if (!folder) { void vscode.window.showWarningMessage("Open a folder containing a Zig project first."); return; }
  const task = new vscode.Task({ type: "zig", task: name }, folder, name, "Zig-Lang-Support", new vscode.ShellExecution(config(resource).zig, args, { cwd: folder.uri.fsPath }), "$zig");
  void vscode.tasks.executeTask(task);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const diagnostics = new CompilerDiagnostics(); const dashboard = new ProjectDashboard();
  const languageStatus = vscode.window.createStatusBarItem("zigLangSupport.zls", vscode.StatusBarAlignment.Right, 100);
  languageStatus.command = "zigLangSupport.restartLanguageServer"; languageStatus.text = "$(symbol-method) ZLS: starting"; languageStatus.show();
  context.subscriptions.push(diagnostics, languageStatus, vscode.window.registerWebviewViewProvider("zigLangSupport.project", dashboard));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: ZIG_LANGUAGE }, new FallbackCompletionProvider(), "@", "."));
  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider({ language: ZIG_LANGUAGE }, new ZigFormatter()));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => diagnostics.schedule(event.document)));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => { if (config(document.uri).diagnosticsOnSave) void diagnostics.refresh(document); void dashboard.refresh(); }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("zigLangSupport")) { void startLanguageServer(context); void dashboard.refresh(); } }));
  context.subscriptions.push(vscode.commands.registerCommand("zigLangSupport.formatDocument", () => vscode.commands.executeCommand("editor.action.formatDocument")));
  context.subscriptions.push(vscode.commands.registerCommand("zigLangSupport.build", () => runTask("build", ["build", ...config().taskArgs])));
  context.subscriptions.push(vscode.commands.registerCommand("zigLangSupport.run", () => runTask("run", ["build", "run", ...config().taskArgs])));
  context.subscriptions.push(vscode.commands.registerCommand("zigLangSupport.test", (uri?: vscode.Uri) => { const target = uri ?? vscode.window.activeTextEditor?.document.uri; runTask("test", target ? ["test", target.fsPath] : ["build", "test"], target); }));
  context.subscriptions.push(vscode.commands.registerCommand("zigLangSupport.fetchDependencies", () => runTask("fetch dependencies", ["build", "--fetch", ...config().taskArgs])));
  context.subscriptions.push(vscode.commands.registerCommand("zigLangSupport.addDependency", () => vscode.commands.executeCommand("workbench.view.extension.zigLangSupport")));
  context.subscriptions.push(vscode.commands.registerCommand("zigLangSupport.restartLanguageServer", async () => { if (client) await client.stop(); client = undefined; await startLanguageServer(context); }));
  context.subscriptions.push(vscode.commands.registerCommand("zigLangSupport.showProject", () => vscode.commands.executeCommand("workbench.view.extension.zigLangSupport")));
  await startLanguageServer(context);
  if (client?.state === State.Running) languageStatus.text = "$(check) ZLS: ready"; else languageStatus.text = "$(warning) ZLS: unavailable";
}

export async function deactivate(): Promise<void> { if (client) await client.stop(); }
