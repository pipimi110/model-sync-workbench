import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const { workspaceDirectory } = createRequire(import.meta.url)('../desktop/workspace.cjs');

test('开发仍使用项目资料库，发布版使用稳定的用户目录而非临时解包目录', () => {
  const project = path.resolve('artifacts/temporary-unpack/resources/app.asar');
  const appData = path.resolve('artifacts/user-roaming');
  assert.equal(workspaceDirectory({ packaged: false, project, appData }), path.join(project, '.data'));
  assert.equal(workspaceDirectory({ packaged: true, project, appData }), path.join(appData, 'ModelPort', 'data'));
  const override = path.resolve('artifacts/custom-workspace');
  for (const packaged of [false, true]) assert.equal(workspaceDirectory({ packaged, project, appData, override }), override);
});
