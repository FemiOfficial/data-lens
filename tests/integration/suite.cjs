const vscode = require('vscode');
const assert = require('assert');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openAndCheck(file, viewType) {
  const uri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, file));
  await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
  await sleep(1500);
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!(tab.input instanceof vscode.TabInputCustom))
    console.log('  active tabs:', vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => `${t.label} [${t.input && t.input.constructor.name}] ${JSON.stringify(t.input)}`)));
  assert.ok(tab.input instanceof vscode.TabInputCustom, `${file}: expected custom editor tab`);
  assert.equal(tab.input.viewType, viewType);
  console.log(`  ✓ ${file} opened in ${viewType}`);
}

exports.run = async () => {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'data-lens');
  assert.ok(ext, 'extension found');
  assert.equal(ext.isActive, false, 'not activated eagerly');
  // The test runner starts before the workbench finishes reading extension contributions.
  await sleep(3000);
  await openAndCheck('sales.csv', 'dataLens.table');
  assert.ok(ext.isActive, 'extension activated');
  console.log('  ✓ extension activated');
  await openAndCheck('inventory.xlsx', 'dataLens.workbook');
  await openAndCheck('users.json', 'dataLens.json');
  await openAndCheck('events.jsonl', 'dataLens.json');
  // Default editor associations: CSV and XLSX open in Data Lens by default, JSON does not.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'sales.csv')));
  await sleep(1200);
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.input.viewType, 'dataLens.table', 'csv opens in Data Lens by default');
  console.log('  ✓ csv opens in Data Lens by default');
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'users.json')));
  await sleep(800);
  assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputText, 'json opens as text by default');
  console.log('  ✓ json stays in the text editor by default');
  await vscode.commands.executeCommand('dataLens.openJson');
  await sleep(1200);
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.input.viewType, 'dataLens.json');
  console.log('  ✓ "Visualize JSON" command switches to Data Lens');
  await vscode.commands.executeCommand('dataLens.openAsText');
  await sleep(800);
  assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputText);
  console.log('  ✓ "Open as Text" switches back');
};
