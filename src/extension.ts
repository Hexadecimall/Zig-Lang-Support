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

interface Dependency { name: string; start: number; end: number; }

interface RegistryPackage {
  id: string;
  name: string;
  description: string;
  license: string;
  minimumZigVersion: string;
  stars: number;
  host: string;
}

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
    result.push({ name: match[1], start: match.index, end: entryEnd }); entry.lastIndex = entryEnd + 1;
  }
  return result;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
const html = (title: string, dependenciesList: Dependency[], hasProject: boolean, nonce: string) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);margin:0;padding:14px;line-height:1.4}.shell{max-width:760px;margin:0 auto}.title{font-size:18px;font-weight:600;margin:0 0 12px;overflow:hidden;text-overflow:ellipsis}.actions{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:22px}.action,.add,.remove{font:inherit;border:0;border-radius:6px;cursor:pointer}.action{padding:5px 10px;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}.action:hover{background:var(--vscode-button-secondaryHoverBackground)}.section{margin-top:20px}.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}.section-title{font-size:13px;font-weight:600}.count{color:var(--vscode-descriptionForeground);font-size:11px}.panel{border:1px solid var(--vscode-panel-border);border-radius:8px;background:var(--vscode-sideBar-background);overflow:hidden}.installed{display:flex;align-items:center;gap:8px;min-height:36px;padding:6px 8px 6px 11px;border-bottom:1px solid var(--vscode-panel-border)}.installed:last-child{border-bottom:0}.package-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis}.remove{width:24px;height:24px;flex:none;color:var(--vscode-descriptionForeground);background:transparent;font-size:16px;line-height:1}.remove:hover{color:var(--vscode-errorForeground);background:var(--vscode-toolbar-hoverBackground)}.empty{padding:14px;text-align:center;color:var(--vscode-descriptionForeground)}.search-wrap{position:relative}.search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--vscode-descriptionForeground);pointer-events:none}input{width:100%;height:34px;padding:0 34px 0 30px;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:7px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);font:inherit;outline:none}input:focus{border-color:var(--vscode-focusBorder)}.spinner{display:none;position:absolute;right:10px;top:9px;width:14px;height:14px;border:2px solid var(--vscode-panel-border);border-top-color:var(--vscode-progressBar-background);border-radius:50%;animation:spin .7s linear infinite}.loading .spinner{display:block}@keyframes spin{to{transform:rotate(360deg)}}.results{margin-top:7px}.result{display:grid;grid-template-columns:1fr auto;gap:6px 10px;padding:10px 11px;border-bottom:1px solid var(--vscode-panel-border)}.result:last-child{border-bottom:0}.result-name{font-weight:600}.description{margin-top:2px;color:var(--vscode-descriptionForeground);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:5px;color:var(--vscode-descriptionForeground);font-size:10px}.chip{font-size:10px}.add{align-self:center;padding:5px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}.add:hover{background:var(--vscode-button-hoverBackground)}.add:disabled{opacity:.55;cursor:default}.error{padding:10px;color:var(--vscode-errorForeground)}
</style></head><body><main class="shell"><div class="title">${escapeHtml(title)}</div>${hasProject ? `<div class="actions"><button class="action" data-action="build">Build</button><button class="action" data-action="run">Run</button><button class="action" data-action="test">Test</button><button class="action" data-action="fetch">Fetch</button></div><section class="section"><div class="section-head"><span class="section-title">Dependencies</span><span class="count">${dependenciesList.length}</span></div><div class="panel">${dependenciesList.map(dep => `<div class="installed"><div class="package-name">${escapeHtml(dep.name)}</div><button class="remove" title="Remove ${escapeHtml(dep.name)}" aria-label="Remove ${escapeHtml(dep.name)}" data-remove="${escapeHtml(dep.name)}">×</button></div>`).join("") || `<div class="empty">No dependencies</div>`}</div></section><section class="section"><div class="section-head"><span class="section-title">Add dependency</span></div><div class="search-wrap" id="searchWrap"><span class="search-icon">⌕</span><input id="search" autocomplete="off" spellcheck="false" placeholder="Search packages" aria-label="Search Zig packages"><span class="spinner"></span></div><div class="panel results" id="results" hidden></div></section>` : `<div class="panel empty">Open a folder containing build.zig.zon.</div>`}</main><script nonce="${nonce}">
const vscode=acquireVsCodeApi();const input=document.getElementById('search');const results=document.getElementById('results');const wrap=document.getElementById('searchWrap');let timer;function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node}function render(items){wrap?.classList.remove('loading');results.replaceChildren();results.hidden=false;if(!items.length){results.append(el('div','empty','No matching packages'));return}for(const item of items){const row=el('div','result');const copy=el('div');copy.append(el('div','result-name',item.name));copy.append(el('div','description',item.description||'Zig package'));const meta=el('div','meta');for(const value of [item.host,item.minimumZigVersion&&('Zig '+item.minimumZigVersion),item.license,item.stars?('★ '+item.stars):''].filter(Boolean))meta.append(el('span','chip',value));copy.append(meta);const add=el('button','add','Add');add.dataset.packageId=item.id;row.append(copy,add);results.append(row)}}input?.addEventListener('input',()=>{clearTimeout(timer);const query=input.value.trim();if(query.length<2){wrap.classList.remove('loading');results.hidden=true;return}wrap.classList.add('loading');timer=setTimeout(()=>vscode.postMessage({type:'search',query}),280)});document.addEventListener('click',event=>{const target=event.target.closest('button');if(!target)return;if(target.dataset.remove)vscode.postMessage({type:'remove',name:target.dataset.remove});if(target.dataset.packageId){target.disabled=true;target.textContent='Adding…';vscode.postMessage({type:'add',packageId:target.dataset.packageId})}if(target.dataset.action)vscode.postMessage({type:target.dataset.action})});window.addEventListener('message',event=>{if(event.data.type==='results')render(event.data.items);if(event.data.type==='searchError'){wrap?.classList.remove('loading');results.hidden=false;results.replaceChildren(el('div','error',event.data.message))}});
</script></body></html>`;

async function searchRegistry(query: string): Promise<RegistryPackage[]> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const endpoint = new URL("https://zigistry-backend.hf.space/search/packages/");
    endpoint.search = new URLSearchParams({ q: query, page: "1", per_page: "20", sort: "intelligent", dir: "desc" }).toString();
    const response = await fetch(endpoint, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Package search returned ${response.status}`);
    const body = await response.json() as { items?: Array<Record<string, unknown>> };
    return (body.items ?? []).flatMap(item => {
      const id = typeof item.id === "string" ? item.id : ""; const name = typeof item.repo_name === "string" ? item.repo_name : "";
      if (!/^(gh|cb)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id) || !name) return [];
      return [{ id, name, description: typeof item.description === "string" ? item.description : "", license: typeof item.license === "string" && item.license !== "-" ? item.license : "", minimumZigVersion: typeof item.minimum_zig_version === "string" ? item.minimum_zig_version : "", stars: typeof item.stargazer_count === "number" ? item.stargazer_count : 0, host: id.startsWith("gh/") ? "GitHub" : "Codeberg" }];
    });
  } finally { clearTimeout(timeout); }
}

function registryTarget(id: string): { name: string; url: string } | undefined {
  const match = /^(gh|cb)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(id); if (!match) return undefined;
  let name = match[3].replace(/[^A-Za-z0-9_]/g, "_"); if (!/^[A-Za-z_]/.test(name)) name = `dep_${name}`;
  const host = match[1] === "gh" ? "github.com" : "codeberg.org";
  return { name, url: `git+https://${host}/${match[2]}/${match[3]}.git` };
}

class ProjectDashboard implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  resolveWebviewView(view: vscode.WebviewView): void { this.view = view; view.webview.options = { enableScripts: true }; view.webview.onDidReceiveMessage(message => void this.handle(message)); this.refresh(); }
  async refresh(): Promise<void> { const folder = workspaceFolder(); if (!folder || !this.view) return; const zon = vscode.Uri.joinPath(folder.uri, "build.zig.zon"); const nonce = `${Date.now()}${Math.random().toString(36).slice(2)}`; try { const text = Buffer.from(await vscode.workspace.fs.readFile(zon)).toString("utf8"); this.view.webview.html = html(folder.name, dependencies(text), true, nonce); } catch { this.view.webview.html = html(folder.name, [], false, nonce); } }
  private async handle(message: { type: string; name?: string; query?: string; packageId?: string }): Promise<void> {
    const folder = workspaceFolder(); if (!folder) return;
    if (["build", "run", "test", "fetch", "restart"].includes(message.type)) { await vscode.commands.executeCommand(`zigLangSupport.${message.type === "restart" ? "restartLanguageServer" : message.type === "fetch" ? "fetchDependencies" : message.type}`); return; }
    if (message.type === "search") {
      const query = message.query?.trim().slice(0, 80) ?? ""; if (query.length < 2) return;
      try { this.view?.webview.postMessage({ type: "results", items: await searchRegistry(query) }); } catch { this.view?.webview.postMessage({ type: "searchError", message: "Package search is unavailable. Try again shortly." }); }
      return;
    }
    if (message.type === "add") {
      const target = registryTarget(message.packageId ?? ""); if (!target) { void vscode.window.showErrorMessage("That package could not be verified."); return; }
      try { await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Adding ${target.name}…` }, () => execFile(config().zig, ["fetch", `--save=${target.name}`, target.url], folder.uri.fsPath)); await this.refresh(); } catch (error) { void vscode.window.showErrorMessage(`Could not add dependency: ${String((error as { stderr?: string }).stderr ?? error)}`); await this.refresh(); }
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
  let suggestionTimer: NodeJS.Timeout | undefined;
  const languageStatus = vscode.window.createStatusBarItem("zigLangSupport.zls", vscode.StatusBarAlignment.Right, 100);
  languageStatus.command = "zigLangSupport.restartLanguageServer"; languageStatus.text = "$(symbol-method) ZLS: starting"; languageStatus.show();
  context.subscriptions.push(diagnostics, languageStatus, vscode.window.registerWebviewViewProvider("zigLangSupport.project", dashboard));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: ZIG_LANGUAGE }, new FallbackCompletionProvider(), "@", "."));
  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider({ language: ZIG_LANGUAGE }, new ZigFormatter()));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    diagnostics.schedule(event.document);
    const editor = vscode.window.activeTextEditor; const inserted = event.contentChanges.at(-1)?.text ?? "";
    if (editor?.document === event.document && event.document.languageId === ZIG_LANGUAGE && editor.selections.length === 1 && /^[A-Za-z0-9_@.]$/.test(inserted)) {
      clearTimeout(suggestionTimer); suggestionTimer = setTimeout(() => void vscode.commands.executeCommand("editor.action.triggerSuggest"), 90);
    }
  }));
  context.subscriptions.push({ dispose: () => clearTimeout(suggestionTimer) });
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
