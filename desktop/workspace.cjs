const path = require('node:path');

// Packaged resources are read-only and portable launchers extract to a temporary
// directory. Keep release data outside both; development keeps its existing data.
function workspaceDirectory({ packaged, appData, project, override }) {
  return path.resolve(override || (packaged
    ? path.join(appData, 'ModelPort', 'data')
    : path.join(project, '.data')));
}

module.exports = { workspaceDirectory };
