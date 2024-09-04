const semverMajor = require('semver/functions/major');
const fs = require('fs');
const path = require('path');

const ARTEFACT_PATH = path.join(__dirname, 'lib', 'artefacts');
if (!fs.existsSync(ARTEFACT_PATH)) {
  fs.mkdirSync(ARTEFACT_PATH);
}

const mver = semverMajor(require('./package.json').version)
fs.writeFileSync(path.join(ARTEFACT_PATH, 'MajorVersion.ts'), 'export const mver = ' + mver + ';\n');
fs.writeFileSync(path.join(ARTEFACT_PATH, 'DefaultContext.ts'), 'export const context = ' + JSON.stringify(require('./components/context.json'), null, 2) + ';\n');
