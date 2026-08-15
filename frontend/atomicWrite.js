const fs = require('fs');

// Writes then renames over the target so a crash mid-write never leaves a
// truncated/corrupt file in place — readers always see the old complete
// version or the new complete version, never a partial one.
function writeFileAtomic(targetPath, data) {
    const tmpPath = `${targetPath}.tmp`;
    const fd = fs.openSync(tmpPath, 'w');
    try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, targetPath);
}

module.exports = { writeFileAtomic };
