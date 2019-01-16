/**
 * Function model
 *
 * A function can be subscribed to a topic or a queue
 */

class Func {

  constructor({name, serverlessConfig}) {
    this.name = name;
    this.serverlessConfig = serverlessConfig;
  }

  get events() {
    return this.serverlessConfig.events || [];
  }

  get pubSubEvents() {
    return this.events.filter(({pubSub}) => pubSub);
  }
}

module.exports = Func;
