import * as vscode from "vscode";

const OUTPUT_CHANNEL = vscode.window.createOutputChannel("cSpell to AutoCorrect");

function log(message: string) {
  OUTPUT_CHANNEL.appendLine(`[${new Date().toISOString()}] ${message}`);
}

async function ensureAutoCorrectRule(
  misspelled: string,
  corrected: string
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration();
  const dict = (cfg.get<any[]>("auto-correct.dictionary") ?? []).slice();

  let global = dict.find(
    (d) => Array.isArray(d?.languages) && d.languages.includes("*")
  );
  if (!global) {
    global = { languages: ["*"], words: {} };
    dict.push(global);
  }

  global.words = global.words ?? {};
  global.words[misspelled] = corrected;

  await cfg.update(
    "auto-correct.dictionary",
    dict,
    vscode.ConfigurationTarget.Workspace
  );
}

async function replaceRangeWith(
  editor: vscode.TextEditor,
  range: vscode.Range,
  text: string
): Promise<void> {
  await editor.edit((eb) => eb.replace(range, text));
}

// Track if we're currently inside our own provider to prevent recursion
let insideOurProvider = false;

export function activate(context: vscode.ExtensionContext) {
  log("Extension activated");

  // Command: apply correction + save rule
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cspellToAutoCorrect.applyAndSave",
      async (args: {
        uri: string;
        range: { start: { line: number; character: number }; end: { line: number; character: number } };
        misspelled: string;
        corrected: string;
      }) => {
        log(`applyAndSave called: ${args.misspelled} -> ${args.corrected}`);

        const uri = vscode.Uri.parse(args.uri);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);

        const range = new vscode.Range(
          new vscode.Position(args.range.start.line, args.range.start.character),
          new vscode.Position(args.range.end.line, args.range.end.character)
        );

        await replaceRangeWith(editor, range, args.corrected);
        await ensureAutoCorrectRule(args.misspelled, args.corrected);

        vscode.window.showInformationMessage(
          `Saved Auto Correct rule: ${args.misspelled} → ${args.corrected}`
        );
      }
    )
  );

  // Code Action Provider
  const provider: vscode.CodeActionProvider = {
    provideCodeActions: async (document, range, context, token) => {
      if (token.isCancellationRequested) return;

      // Prevent infinite recursion
      if (insideOurProvider) {
        return [];
      }

      const cspellDiagnostics = context.diagnostics.filter(
        (d) => d.source === "cSpell"
      );

      if (cspellDiagnostics.length === 0) return [];

      log(`Found ${cspellDiagnostics.length} cSpell diagnostic(s)`);

      const wrapped: vscode.CodeAction[] = [];

      for (const diagnostic of cspellDiagnostics) {
        const diagnosticRange = diagnostic.range;
        const misspelled = document.getText(diagnosticRange);

        log(`Processing diagnostic for: "${misspelled}"`);
        log(`Diagnostic data: ${JSON.stringify((diagnostic as any).data)}`);

        // Try to get suggestions from diagnostic data first
        const data = (diagnostic as any).data;
        let suggestions: string[] = [];

        if (data?.suggestions && Array.isArray(data.suggestions)) {
          suggestions = data.suggestions;
          log(`Got ${suggestions.length} suggestions from diagnostic data`);
        }

        // If no suggestions in data, try fetching code actions from cSpell
        if (suggestions.length === 0) {
          log("No suggestions in diagnostic data, fetching code actions...");

          insideOurProvider = true;
          try {
            const actions = (await vscode.commands.executeCommand(
              "vscode.executeCodeActionProvider",
              document.uri,
              diagnosticRange,
              vscode.CodeActionKind.QuickFix.value
            )) as (vscode.CodeAction | vscode.Command)[] | undefined;

            if (actions?.length) {
              log(`Got ${actions.length} code actions`);
              for (const a of actions) {
                const title = (a as any)?.title;
                if (typeof title !== "string") continue;

                log(`  Action: "${title}"`);

                // Skip our own actions
                if (title.includes("Auto Correct")) continue;

                // Skip "Add to dictionary" actions
                if (title.startsWith("Add:")) continue;

                // cSpell suggestions are just the word itself (e.g., "situation")
                // They don't contain spaces or special prefixes
                if (/^[A-Za-zÀ-ÖØ-öø-ÿ'-]+$/.test(title)) {
                  suggestions.push(title);
                }
              }
            }
          } finally {
            insideOurProvider = false;
          }
        }

        log(`Final suggestions: ${JSON.stringify(suggestions)}`);

        // Create our code actions
        for (const corrected of suggestions) {
          if (typeof corrected !== "string" || !corrected) continue;

          const actionTitle = `Fix: "${misspelled}" → "${corrected}" + Auto Correct`;
          const ca = new vscode.CodeAction(
            actionTitle,
            vscode.CodeActionKind.QuickFix
          );

          ca.diagnostics = [diagnostic];
          ca.isPreferred = true;

          ca.command = {
            command: "cspellToAutoCorrect.applyAndSave",
            title: actionTitle,
            arguments: [
              {
                uri: document.uri.toString(),
                range: {
                  start: { line: diagnosticRange.start.line, character: diagnosticRange.start.character },
                  end: { line: diagnosticRange.end.line, character: diagnosticRange.end.character },
                },
                misspelled,
                corrected,
              },
            ],
          };

          wrapped.push(ca);
        }
      }

      log(`Returning ${wrapped.length} code action(s)`);
      return wrapped;
    },
  };

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      provider,
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  );
}

export function deactivate() {}
