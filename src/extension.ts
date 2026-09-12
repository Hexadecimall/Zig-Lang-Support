import * as childProcess from "node:child_process";
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
  const get = vscode.workspace.getConfiguration("zigForge", resource);
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
  private readonly collection = vscode.languages.createDiagnosticCollection("zig-forge");
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

class ZigProjectProvider implements vscode.TreeDataProvider<ZigProjectItem> {
  private readonly change = new vscode.EventEmitter<ZigProjectItem | undefined>();
  readonly onDidChangeTreeData = this.change.event;
  refresh(): void { this.change.fire(undefined); }
  getTreeItem(item: ZigProjectItem): vscode.TreeItem { return item; }
  async getChildren(): Promise<ZigProjectItem[]> {
    const folder = workspaceFolder(); if (!folder) return [new ZigProjectItem("Open a Zig workspace", vscode.TreeItemCollapsibleState.None)];
    const result: ZigProjectItem[] = [];
    for (const name of ["build.zig", "build.zig.zon"]) {
      const uri = vscode.Uri.joinPath(folder.uri, name);
      try { await vscode.workspace.fs.stat(uri); result.push(new ZigProjectItem(name, vscode.TreeItemCollapsibleState.None, { command: "vscode.open", title: "Open", arguments: [uri] })); } catch { /* absent */ }
    }
    result.push(new ZigProjectItem("Build project", vscode.TreeItemCollapsibleState.None, { command: "zigForge.build", title: "Build" }));
    result.push(new ZigProjectItem("Fetch dependencies", vscode.TreeItemCollapsibleState.None, { command: "zigForge.fetchDependencies", title: "Fetch dependencies" }));
    return result;
  }
}

class ZigProjectItem extends vscode.TreeItem { constructor(label: string, state: vscode.TreeItemCollapsibleState, command?: vscode.Command) { super(label, state); this.command = command; this.contextValue = "zigForge.item"; } }

let client: LanguageClient | undefined;

async function startLanguageServer(context: vscode.ExtensionContext): Promise<void> {
  if (!config().zlsEnabled || client?.state === State.Running) return;
  const folder = workspaceFolder();
  try {
    await execFile(config().zls, ["--version"], folder?.uri.fsPath);
  } catch {
    return;
  }
  const serverOptions: ServerOptions = { command: config().zls, args: [], options: { cwd: folder?.uri.fsPath } };
  const clientOptions: LanguageClientOptions = { documentSelector: [{ language: ZIG_LANGUAGE, scheme: "file" }], synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{zig,zon}") }, outputChannelName: "Zig Forge Language Server" };
  client = new LanguageClient("zigForge.zls", "Zig Forge Language Server", serverOptions, clientOptions);
  context.subscriptions.push(client);
  try { await client.start(); } catch { client = undefined; }
}

function runTask(name: string, args: string[], resource?: vscode.Uri): void {
  const folder = workspaceFolder(resource);
  if (!folder) { void vscode.window.showWarningMessage("Open a folder containing a Zig project first."); return; }
  const task = new vscode.Task({ type: "zig", task: name }, folder, name, "Zig Forge", new vscode.ShellExecution(config(resource).zig, args, { cwd: folder.uri.fsPath }), "$zig");
  void vscode.tasks.executeTask(task);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const diagnostics = new CompilerDiagnostics(); const projects = new ZigProjectProvider();
  context.subscriptions.push(diagnostics, vscode.window.registerTreeDataProvider("zigForge.project", projects));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: ZIG_LANGUAGE }, new FallbackCompletionProvider(), "@", "."));
  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider({ language: ZIG_LANGUAGE }, new ZigFormatter()));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => diagnostics.schedule(event.document)));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => { if (config(document.uri).diagnosticsOnSave) void diagnostics.refresh(document); projects.refresh(); }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("zigForge")) { void startLanguageServer(context); projects.refresh(); } }));
  context.subscriptions.push(vscode.commands.registerCommand("zigForge.formatDocument", () => vscode.commands.executeCommand("editor.action.formatDocument")));
  context.subscriptions.push(vscode.commands.registerCommand("zigForge.build", () => runTask("build", ["build", ...config().taskArgs])));
  context.subscriptions.push(vscode.commands.registerCommand("zigForge.run", () => runTask("run", ["build", "run", ...config().taskArgs])));
  context.subscriptions.push(vscode.commands.registerCommand("zigForge.test", (uri?: vscode.Uri) => { const target = uri ?? vscode.window.activeTextEditor?.document.uri; runTask("test", target ? ["test", target.fsPath] : ["build", "test"], target); }));
  context.subscriptions.push(vscode.commands.registerCommand("zigForge.fetchDependencies", () => runTask("fetch dependencies", ["build", "--fetch", ...config().taskArgs])));
  context.subscriptions.push(vscode.commands.registerCommand("zigForge.addDependency", async () => { const url = await vscode.window.showInputBox({ prompt: "Package URL (zig fetch --save)", placeHolder: "https://example.com/package.tar.gz" }); if (url) runTask("add dependency", ["fetch", "--save", url]); }));
  context.subscriptions.push(vscode.commands.registerCommand("zigForge.restartLanguageServer", async () => { if (client) await client.stop(); client = undefined; await startLanguageServer(context); }));
  context.subscriptions.push(vscode.commands.registerCommand("zigForge.showProject", () => vscode.commands.executeCommand("workbench.view.extension.zigForge")));
  await startLanguageServer(context);
}

export async function deactivate(): Promise<void> { if (client) await client.stop(); }
