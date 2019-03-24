const crypto = require('crypto');


module.exports = {
  randomId: () => crypto.randomBytes(16).toString('hex'),
  formatCLIOptions: (opts) => {
    const cliSegments = [];
    for (let key in opts) {
      const flag = `${key.length > 1 ? '--' : '-'}${key}`;
      const optionValue = opts[key];
      if (optionValue) {
        const values = Array.isArray(optionValue) ? optionValue : [optionValue];
        values.forEach((value) => {
          cliSegments.push(flag);
          cliSegments.push(value);
        });
      }
    }
    return cliSegments;
  }
};

