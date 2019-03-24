
const helpers = require('../helpers');

describe('formatCLIOptions helper', () => {
  it('should format cli options array', () => {
    const res = helpers.formatCLIOptions({
      'e': ['a', 'b', 'c'],
      'function': 'someFuncName',
    });
    expect(res).toEqual([
      '-e', 'a',
      '-e', 'b',
      '-e', 'c',
      '--function', 'someFuncName'
    ]);
  });
});
