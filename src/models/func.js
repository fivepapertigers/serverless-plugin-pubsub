/**
 * Function model
 *
 * A function can be subscribed to a topic or a queue
 */

const execFile = require('child_process').execFile;
const logger = require('../logger');
const helpers = require('../helpers');
const os = require('os');

class Func {

  constructor({name, invokeOpts, serverlessConfig}) {
    this.name = name;
    this.serverlessConfig = serverlessConfig;
    this.invokeOpts = invokeOpts;
    this.type = 'function';
  }

  get events() {
    return this.serverlessConfig.events || [];
  }

  get pubSubEvents() {
    return this.events.filter(({pubSub}) => pubSub);
  }

  execute(data) {
    let args = ['invoke', 'local'];
    if (this.invokeOpts) {
      args = args.concat(helpers.formatCLIOptions(this.invokeOpts));
    }
    args = args.concat([
      '-f',
      this.name,
      '-e',
      'SNS_ENDPOINT_URL=http://localhost:3100',
      '-d',
      data,
    ]);

    this.log(`Invoking with ${data}`);
    execFile('sls', args, (err, stdout, stderr) => {
      if (err) {
        this.log(`Error in sls invoke local: ${err} ${err.stack}`);
      }
      this.logOutput(stderr);
      this.logOutput(stdout);
    });
  }

  logOutput (buffer) {
    if (buffer) {
      buffer.toString().split(os.EOL).forEach(this.log.bind(this));
    }
  }

  log(message) {
    logger.log(message, ['Function', this.name]);
  }


}

module.exports = Func;
