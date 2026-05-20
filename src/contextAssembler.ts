import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SymbolRef } from './types';

export interface DroppedItem {
  uri: vscode.Uri;
  label: string;
  isFolder: boolean;
}

export interface AssembledContext {
  prompt: string;
  hasProjectContext: boolean;
}

export async function assembleContext(
  userMessage: string,
  workspaceRoot: string,
  droppedItems: DroppedItem[],
  selection?: { text: string; filePath: string; languageId: string },
  activeFile?: { text: string; filePath: string; languageId: string },
  symbolRefs?: SymbolRef[],
): Promise<AssembledContext> {
  const parts: string[] = [];

  const projectContextPath = path.join(workspaceRoot, '.claude', 'project-context.md');
  let hasProjectContext = false;
  if (fs.existsSync(projectContextPath)) {
    const content = fs.readFileSync(projectContextPath, 'utf8');
    parts.push(`<project-context>\n${content}\n</project-context>`);
    hasProjectContext = true;
  }

  if (selection) {
    parts.push(
      `<context source="selection" file="${selection.filePath}" lang="${selection.languageId}">\n${selection.text}\n</context>`
    );
  } else if (activeFile) {
    parts.push(
      `<context source="active-file" file="${activeFile.filePath}" lang="${activeFile.languageId}">\n${activeFile.text}\n</context>`
    );
  }

  for (const item of droppedItems) {
    const droppedContent = await readDropped(item);
    if (droppedContent) {
      parts.push(droppedContent);
    }
  }

  for (const ref of symbolRefs ?? []) {
    const snippet = await readSymbolSnippet(ref);
    if (snippet) { parts.push(snippet); }
  }

  parts.push(`<user-message>\n${userMessage}\n</user-message>`);

  return { prompt: parts.join('\n\n'), hasProjectContext };
}

async function readSymbolSnippet(ref: SymbolRef): Promise<string | null> {
  try {
    const uri = vscode.Uri.file(ref.filePath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const lines = Buffer.from(bytes).toString('utf8').split('\n');
    const start = Math.max(0, ref.line - 1 - 8);
    const end   = Math.min(lines.length, ref.line - 1 + 20);
    const snippet = lines.slice(start, end).join('\n');
    return `<symbol-ref name="${ref.name}" kind="${ref.kind}" file="${ref.filePath}" line="${ref.line}">\n${snippet}\n</symbol-ref>`;
  } catch { return null; }
}

async function readDropped(item: DroppedItem): Promise<string | null> {
  const config = vscode.workspace.getConfiguration('claude');
  const maxKb: number = config.get('maxFolderContextKb', 500);
  const maxBytes = maxKb * 1024;

  try {
    const stat = await vscode.workspace.fs.stat(item.uri);

    if (item.isFolder || stat.type === vscode.FileType.Directory) {
      const listing = await buildFolderListing(item.uri);
      const totalSize = await estimateFolderSize(item.uri);
      if (totalSize > maxBytes) {
        return `<context source="folder" path="${item.uri.fsPath}" warning="exceeds-size-cap">\n${listing}\n</context>`;
      }
      const contents = await readFolderContents(item.uri, maxBytes);
      return `<context source="folder" path="${item.uri.fsPath}">\n${listing}\n\n${contents}\n</context>`;
    } else {
      // Don't try to decode image/binary files as UTF-8 text
      const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tiff', '.avif']);
      const ext = path.extname(item.label).toLowerCase();
      if (imageExts.has(ext)) {
        return `<context source="image" path="${item.uri.fsPath}">Image file: ${item.label}</context>`;
      }
      const bytes = await vscode.workspace.fs.readFile(item.uri);
      const text = Buffer.from(bytes).toString('utf8');
      return `<context source="file" path="${item.uri.fsPath}">\n${text}\n</context>`;
    }
  } catch {
    return null;
  }
}

async function buildFolderListing(uri: vscode.Uri, indent = ''): Promise<string> {
  const lines: string[] = [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    for (const [name, type] of entries) {
      if (name.startsWith('.') || name === 'node_modules') { continue; }
      if (type === vscode.FileType.Directory) {
        lines.push(`${indent}${name}/`);
        const sub = await buildFolderListing(vscode.Uri.joinPath(uri, name), indent + '  ');
        lines.push(sub);
      } else {
        lines.push(`${indent}${name}`);
      }
    }
  } catch { /* skip unreadable */ }
  return lines.join('\n');
}

async function estimateFolderSize(uri: vscode.Uri): Promise<number> {
  let total = 0;
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    for (const [name, type] of entries) {
      if (name.startsWith('.') || name === 'node_modules') { continue; }
      const child = vscode.Uri.joinPath(uri, name);
      if (type === vscode.FileType.Directory) {
        total += await estimateFolderSize(child);
      } else {
        const stat = await vscode.workspace.fs.stat(child);
        total += stat.size;
      }
    }
  } catch { /* skip */ }
  return total;
}

async function readFolderContents(uri: vscode.Uri, maxBytes: number): Promise<string> {
  const parts: string[] = [];
  let accumulated = 0;

  async function walk(dirUri: vscode.Uri): Promise<void> {
    if (accumulated >= maxBytes) { return; }
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    for (const [name, type] of entries) {
      if (name.startsWith('.') || name === 'node_modules') { continue; }
      const child = vscode.Uri.joinPath(dirUri, name);
      if (type === vscode.FileType.Directory) {
        await walk(child);
      } else {
        if (accumulated >= maxBytes) { break; }
        try {
          const bytes = await vscode.workspace.fs.readFile(child);
          const text = Buffer.from(bytes).toString('utf8');
          accumulated += bytes.byteLength;
          parts.push(`--- ${child.fsPath} ---\n${text}`);
        } catch { /* skip */ }
      }
    }
  }

  await walk(uri);
  return parts.join('\n\n');
}

export function getActiveEditorContext(): {
  selection?: { text: string; filePath: string; languageId: string };
  activeFile?: { text: string; filePath: string; languageId: string };
} {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return {}; }

  const doc = editor.document;
  const filePath = doc.fileName;
  const languageId = doc.languageId;

  if (!editor.selection.isEmpty) {
    return {
      selection: {
        text: doc.getText(editor.selection),
        filePath,
        languageId,
      },
    };
  }

  return {
    activeFile: {
      text: doc.getText(),
      filePath,
      languageId,
    },
  };
}
