class Logger {
  init(serverless) {
    this.logger = serverless.cli;
  }

  log(message, identifier = '') {
    if (identifier) {
      identifier = (`(${identifier.join(':') || []}) `);
    }
    this.logger.log(`[PubSub] ${identifier}${message}`);
  }
}

module.exports = new Logger();
