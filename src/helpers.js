const crypto = require('crypto');


module.exports = {
  randomId: () => crypto.randomBytes(16).toString('hex'),
};

