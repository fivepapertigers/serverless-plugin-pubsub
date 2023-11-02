/**
 * A plugin for easier publish/subscribe patterns in the serverless framework
 */


const Server = require('./offline');
const {
  Func, Topic, Queue, QueueToFuncSubscription,
  TopicToQueueSubscription, TopicToFuncSubscription
} = require('./models');

const logger = require('./logger');

const pubSubTopicSyntax = RegExp(/^pubSubTopic:/g);



function unique(iterable, selector) {
  let results = new Set();
  return iterable.filter(item => {
    const result = selector(item);
    if (results.has(result)) {
      return false;
    }
    results.add(results);
    return true;
  });
}

/**
 * Collects the topic name from a pubSub event
 * @param  {object} pubSub PubSub event
 * @return {string}        topic name
 */
function pullTopicNameFromEvent(pubSub) {
  let name;
  // pubSub may be set to a string, in which case, we interpret
  // that as the topic name (and assume no queue config)
  if (typeof pubSub === 'string') {
    name = pubSub;
  // topic may also be set to a string, in which case we interpret that
  // as the topic name
  } else if (pubSub && typeof pubSub.topic === 'string') {
    name = pubSub.topic;
    // topic may also be an object, in which case topic.name is the topic
    // name, and we pull subscription from the topic object as well
  } else if (pubSub && pubSub.topic) {
    name = pubSub.topic.name;
  }

  return name;
}


/**
 * Collects the queue name from a pubSub event
 * @param  {object} pubSub PubSub event
 * @return {string}        queue name
 */
function pullQueueNameFromEvent(pubSub, func) {
  let name;

  // Short-circuit if no queue attribute, or falsey
  if (!pubSub || !pubSub.queue) {
    return null;
  } else if (pubSub.queue === true) {
    name = `${func.name}-queue`;
  } else if (typeof pubSub.queue === 'string') {
    name = pubSub.queue;
  } else {
    return pubSub.queue.name;
  }

  return name;
}


/**
 * Collects queue subscription details from a pubSub event
 * @param  {object} pubSub PubSub event
 * @return {object}        subscription details
 */
function pullQueueSubscriptionDetailsFromEvent(pubSub) {
  return (pubSub && pubSub.queue && pubSub.queue.subscription) || null;
}


/**
 * Collects topic subscription details from a pubSub event
 * @param  {object} pubSub PubSub event
 * @return {object}        subscription details
 */
function pullTopicSubscriptionDetailsFromEvent(pubSub) {
  return (pubSub && pubSub.topic && pubSub.topic.subscription) || null;
}

/**
 * Pulls the external topic arn from the pubSub Event if it is defined
 * @param  {object} pubSub PubSub event
 * @return {object}
 */
function topicExternalArn(pubSub) {
  return (pubSub && pubSub.topic && pubSub.topic.arn) || null;
}


function getOrSet(name, collection, createFunc) {
  let item = collection.find(i => i.name === name);
  if (!item) {
    item = createFunc();
    collection.push(item);
  }
  return item;
}

class ServerlessPluginPubSub {

  /**
   * Setup plugin using the standard plugin constructor
   */
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.naming = this.serverless.getProvider('aws').naming;

    logger.init(this.serverless);
    Server.config(this.offlineConfig);

    const cmd = this.serverless.processedInput.commands.join(' ');
    if (cmd === 'invoke local' || cmd === 'pubSub offline') {
      this.offlineMode = true;
      this.injectOfflineEnv();
    }

    // Note: getQueueLogicalId gets the event source mapping logical Id
    this.naming.getActualQueueLogicalId = (queueName) =>
        `SQSQueue${this.naming.normalizeNameToAlphaNumericOnly(queueName)}`;

    this.naming.getQueueSubscriptionLogicalId = (topicName, queueName) =>
        `${this.naming.getActualQueueLogicalId(queueName)}To${this.naming.getTopicLogicalId(topicName)}Subscription`;

    this.commands = {
      pubSub: {
        usage: 'Pubsub Commands',
        lifecycleEvents: [
          'pubSub'
        ],
        commands: {
          offline: {
            usage: 'Run pubSub topics locally',
            lifecycleEvents: ['offline']
          }
        }
      }
    };
    this.hooks = {
      'after:package:initialize':
        () => {
          this.collectPubSubResourcesFromFunctions();
          this.collectPubSubResourcesFromCustomConfig();
          this.adjustQueueVisibilityTimeout();
          this.generateAdditionalEvents();
          this.generateAllCustomResources();
          this.allowLambdasToPublishSNS();
          this.allowSNSToSQSSubscriptions();
          return Promise.resolve();
        },
      'pubSub:offline:offline': () => {
        this.collectPubSubResourcesFromFunctions();
        this.collectPubSubResourcesFromCustomConfig();
        return this.startServer();
      }
    };


    this.topics = [];
    this.funcs = [];
    this.subscriptions = [];
    this.queues = [];


    this.injectVariableReplacementSyntax();

  }

  /**
   * Gets a Topic from the global state or creates one
   * @param  {string} queueName   Name of the topic
   * @return {Topic}
   */
  getTopic(topicName, arn = null) {
   return getOrSet(topicName, this.topics, () => new Topic({
        name: topicName,
        vendorConfig: this.customTopics[topicName] || {},
        arn: arn
    }));
  }

  /**
   * Gets a Queue from the global state or creates one
   * @param  {string} queueName   Name of the queue
   * @return {Queue}
   */
  getQueue(queueName) {
    return getOrSet(queueName, this.queues, () => new Queue({
      name: queueName, vendorConfig: this.customQueues[queueName] || {}
    }));
  }

  /**
   * Gets a Func from the global state or creates one
   * @param  {string} funcName   Name of the serverless function
   * @param  {object} funcConfig The serveless config for the function
   * @return {Func}
   */
  getFunc(funcName, funcConfig) {
    return getOrSet(funcName, this.funcs, () => new Func({
      name: funcName,
      invokeOpts: this.options,
      serverlessConfig: funcConfig
    }));
  }

  /**
   * Collects all pubSub resources that are references in the service's
   * pubSub events.
   */
  collectPubSubResourcesFromFunctions(){
    const funcs = this.serverless.service.functions || {};

    // Loops over all function definitions
    Object.keys(funcs).forEach(funcName => {

      // Get the Func resource for this function (creating it doesn't exist)
      const func = this.getFunc(funcName, funcs[funcName]);

      // Loop over all of the Func's pubSub events
      func.pubSubEvents.forEach(({pubSub}) => {

        // Pull the topic name (required)
        const topicName = pullTopicNameFromEvent(pubSub);
        if (!topicName) {
          throw Error(`No topic could be identified for pubSub subscription to ${funcName}`);
        }

        // Get the external Arn for the topic
        const externalArn = topicExternalArn(pubSub);

        // Get or create the Topic resource
        const topic = this.getTopic(topicName, externalArn);

        // Pull the topic subscription details
        const topicSubDetails = pullTopicSubscriptionDetailsFromEvent(pubSub);

        // Pull the queue name
        const queueName = pullQueueNameFromEvent(pubSub, func);

        // If a queue is defined, we assume Topic -> Queue -> Func
        if (queueName) {

          // Get or create the Queue Resource
          const queue = this.getQueue(queueName);

          // Create the [Queue -> Func] and the [Topic -> Queue] subscriptions
          this.subscriptions.push(
            new QueueToFuncSubscription({
              origin: queue,
              subscriber: func,
              vendorConfig: pullQueueSubscriptionDetailsFromEvent(pubSub)
            }),
            new TopicToQueueSubscription({
              origin: topic,
              subscriber: queue,
              vendorConfig: topicSubDetails
            })
          );
        // If a queue is not defined, we assume Topic -> Func
        } else {
          // Create the [Topic -> Func] subscription
          this.subscriptions.push(
            new TopicToFuncSubscription({
              origin: topic,
              subscriber: func,
              vendorConfig: topicSubDetails
            })
          );
        }
      });
    });
  }

  /**
   * Collects all pubSub resources that are defined in the custom config
   */
  collectPubSubResourcesFromCustomConfig(){
    // Gets or creates all custom-defined topics
    for (let topicName in this.customTopics) {
      this.getTopic(topicName);
    }
    // Gets or creates all custom-defined queues
    for (let queueName in this.customQueues) {
      this.getQueue(queueName);
    }
  }


  /**
   * Generates sns or sqs events for all subscriptions in the stack
   */
  generateAdditionalEvents() {
    this.subscriptions.forEach(sub => {
      if (sub instanceof TopicToFuncSubscription) {
        this.generateSNSEventFromSubscription(sub);
      } else if (sub instanceof QueueToFuncSubscription) {
        this.generateSQSEventFromSubscription(sub);
      }
    });
  }

  /**
   * Generates sqs events for a given subscription
   * @param {QueueToFuncSubscription} sub
   */
  generateSQSEventFromSubscription(sub) {
    const func = sub.subscriber;
    const queueName = sub.origin.name;
    func.events.push({sqs: {
      arn: {
        'Fn::GetAtt': [
          this.naming.getActualQueueLogicalId(queueName),
          'Arn'
        ]
      }
    }});
  }

  /**
   * Generates sns events for a given subscription
   * @param {TopicToFuncSubscription} sub
   */
  generateSNSEventFromSubscription(sub) {
    const func = sub.subscriber;
    const topicName = sub.origin.name;
    if (sub.origin.arn) {
      func.events.push({
        sns: {arn: sub.origin.arn}
      });
    } else {
      func.events.push({
        sns: {
          arn: this.formatTopicArn(sub.origin),
          topicName: this.namespaceResource(topicName)
        }
      });
    }
  }

  /**
   * Generates all custom pubSub resources for the stack
   */
  generateAllCustomResources() {
    this.queues.forEach(q => this.generateSQSResource(q));
    this.topics
      // Only create topics without a hard-coded arn
      .filter(t => !t.arn)
      .forEach(t => this.generateSNSResource(t));
    this.subscriptions.forEach(s =>
      s instanceof QueueToFuncSubscription
        ? this.generateSQSLambdaSubscription(s)
        : this.generateSNSSubscription(s)
      );
  }


  /**
   * Generates the AWS::SQS::Queue resource for a given Queue
   * @param  {Queue} queue
   */
  generateSQSResource(queue) {
    const queueLogicalId = this.naming.getActualQueueLogicalId(queue.name);
    const props = {
      QueueName: this.namespaceResource(queue.name)
    };
    this.slsCustomResources[queueLogicalId] = {
      Type: 'AWS::SQS::Queue',
      Properties: Object.assign(
        {}, this.queueDefaults, props, queue.vendorConfig
      )
    };
  }

  /**
   * Generates the AWS::SNS::Topic resource for a given Topic
   * @param  {Topic} topic
   */
  generateSNSResource(topic) {
    const logicalId = this.naming.getTopicLogicalId(topic.name);
    const props = {
      TopicName: this.namespaceResource(topic.name)
    };
    this.slsCustomResources[logicalId] = {
      Type: 'AWS::SNS::Topic',
      Properties: Object.assign(
        {}, this.topicDefaults, props, topic.vendorConfig
      ),
    };
  }

  /**
   * Generates the AWS::SNS::Subscription resource for a given Subscription
   * @param  {Topic} topic
   */
  generateSNSSubscription(sub) {
    const logicalId = sub instanceof TopicToFuncSubscription
      ? this.naming.getLambdaSnsSubscriptionLogicalId(
        sub.subscriber.name,
        sub.origin.name
      )
      : this.naming.getQueueSubscriptionLogicalId(
        sub.origin.name,
        sub.subscriber.name,
      );

    const props = {
      TopicArn: sub.origin.arn || {
        Ref: this.naming.getTopicLogicalId(sub.origin.name)
      },
      Protocol: sub instanceof TopicToFuncSubscription ? 'lambda' : 'sqs',
      Endpoint:
        {
          'Fn::GetAtt': [
            sub instanceof TopicToFuncSubscription
              ? this.naming.getLambdaLogicalId(sub.subscriber.name)
              : this.naming.getActualQueueLogicalId(sub.subscriber.name),
            'Arn'
          ]
        },
    };
    this.slsCustomResources[logicalId] = {
      Type: 'AWS::SNS::Subscription',
      Properties: Object.assign(
        {}, this.topicSubscriptionDefaults, props, sub.vendorConfig
      )
    };
  }

  /**
   * Generates the AWS::Lambda::EventSourceMapping resource for a given
   * [Queue -> Func] subscription
   * @param  {sub} QueueToFuncSubscription
   */
  generateSQSLambdaSubscription(sub) {
    const logicalId = this.naming.getQueueLogicalId(
      sub.subscriber.name,
      this.naming.getActualQueueLogicalId(sub.origin.name),
    );

    const props = {
      EventSourceArn: {
        'Fn::GetAtt': [
          this.naming.getActualQueueLogicalId(sub.origin.name),
          'Arn'
        ]
      },
      FunctionName: {
        'Fn::GetAtt': [
          this.naming.getLambdaLogicalId(sub.subscriber.name),
          'Arn'
        ]
      },
    };
    this.slsCustomResources[logicalId] = {
      Type: 'AWS::Lambda::EventSourceMapping',
      Properties: Object.assign(
        {}, this.queueSubscriptionDefaults, props, sub.vendorConfig
      )
    };
  }

  /**
   * Sets the default visibility timeouts of all queues to be five seconds
   * longer than the longest function timeout. This prevents CloudFormation
   * errors that are thrown when the queue visibility timeout is less than the
   * function timeout
   */

  adjustQueueVisibilityTimeout() {
    const providerTimeout = this.serverless.service.provider.timeout;
    const subsByQueue = this.subscriptions.reduce(
      (accum, sub) => {
        if (sub instanceof QueueToFuncSubscription) {
          const queue = sub.origin;
          const subs = accum[queue.name] || [];
          subs.push(sub);
          accum[queue.name] = subs;
        }
        return accum;
      },
      {}
    );


    for (let queueName in subsByQueue) {
      const subs = subsByQueue[queueName];
      const queue = subs[0].origin;
      const vendorConfig = queue.vendorConfig || {};
      const configuredTimeout = vendorConfig.VisibilityTimeout || this.queueDefaults.VisibilityTimeout;

      const timeouts = subs.map(sub =>
        sub.subscriber.serverlessConfig.timeout || providerTimeout || 6
      );

      const maxFunctionTimeout = Math.max(...timeouts);
      // If visibility timeout is manually configured, either throw an error or
      // short-circuit
      if (configuredTimeout) {
        if (configuredTimeout < maxFunctionTimeout) {
          throw new Error(
            `Specified visibility timeout for ${queue.name} (${configuredTimeout}s) is less than function timeout (${maxFunctionTimeout}s)`
          );
        }
      } else {
        vendorConfig.VisibilityTimeout = maxFunctionTimeout + 5;
        queue.vendorConfig = vendorConfig;
      }

    }
  }

  /**
   * Gets the plugin configuration
   * @return {object} plugin config
   */
  get config () {
    return (
      this.serverless.service.custom
      && this.serverless.service.custom
      && this.serverless.service.custom.pubSub
    ) || {};
  }

  /**
   * Gets the topics defined in the plugin configuration
   * @return {object} mapping of topic name and CFM resource
   */
  get customTopics () {
    return (this.config && this.config.topics) || {};
  }

  /**
   * Gets the queues defined in the plugin configuration
   * @return {object} mapping of queue name and CFM resource
   */
  get customQueues () {
    return (this.config && this.config.queues) || {};
  }


  get topicDefaults() {
    return this.defaults.topics || {};
  }

  get queueDefaults() {
    return this.defaults.queues || {};
  }

  get topicSubscriptionDefaults() {
    return this.defaults.topicSubscriptions || {};
  }

  get queueSubscriptionDefaults() {
    return this.defaults.queueSubscriptions || {};
  }

  get defaults() {
    return this.config.defaults || {};
  }


  /**
   * The offline configuration settings
   * @return {[type]} [description]
   */
  get offlineConfig() {
    return this.config.offline || {};
  }

  /**
   * The custom resources defined for the serverless stack
   * @return {object} AWS Cloudformation mapping
   */
  get slsCustomResources() {
    if (!this.serverless.service.resources) {
      this.serverless.service.resources = {Resources: {}};
    } else if (!this.serverless.service.resources.Resources) {
      this.serverless.service.resources.Resources = {};
    }
    return this.serverless.service.resources.Resources;
  }

  /**
   * Namespaces a resource by prefixing it with the service and stage
   * @param {string} resourceName Name of the resource
   * @return {string}
   */
  namespaceResource(resourceName) {
    return `${this.stackPrefix}${resourceName}`;
  }

  /**
   * The prefix for resources in the stack
   */

  get stackPrefix() {
    const serviceName = this.serverless.service.service;
    const stage = this.serverless.getProvider('aws').getStage();
    return `${serviceName}-${stage}-`;

  }

  /**
   * Returns the topic Arn as a Cloudformation join expression
   * @param  {string} topic the topic name
   * @return {object}       Cloudformation join expression that builds the Arn
   */
  formatTopicArn(topic) {
    if (this.offlineMode) {
      return `arn:aws:sns:us-east-1:1234567890123:${this.namespaceResource(topic.name)}`;
    }
    return {
      'Fn::Join': [
        ':', [
          'arn',
          {Ref: 'AWS::Partition'},
          'sns',
          {Ref: 'AWS::Region'}, {Ref: 'AWS::AccountId'},
          this.namespaceResource(topic.name)
        ]
      ]

    };
  }

  /**
   * Injects the pubSubTopic replacement syntax into the serverless variable
   * processing
   */
  injectVariableReplacementSyntax() {
    const getTopic = this.getTopic.bind(this);
    const formatTopicArn = this.formatTopicArn.bind(this);

    this.configurationVariablesSources = {
      pubSubTopic: {
        async resolve({ address }) {

          // Resolver is expected to return an object with the value in the `value` property:
          return {
            value: formatTopicArn(getTopic(address)),
          };
        },
      }
    };
  }

  /**
   * Allows lambda to publish to the topics in the stack
   */
  allowLambdasToPublishSNS() {
    const statements = this.serverless.service.provider.iamRoleStatements || [];
    this.serverless.service.provider.iamRoleStatements = statements;

    statements.push({
      Effect: 'Allow',
      Action: ['sns:Publish'],
      Resource: this.topics.map(t => t.arn || this.formatTopicArn(t))
    });
  }

  /**
   * Allows SQS queues to poll SNS topics
   */
  allowSNSToSQSSubscriptions() {

    const queueArns = unique(this.queues, (q) => q.name)
      .map(q => ({Ref: this.naming.getActualQueueLogicalId(q.name)}));

    const topicArns = unique(this.topics, (t) => t.name)
      .map(t => t.arn || {Ref: this.naming.getTopicLogicalId(t.name)});

    const policy = this.slsCustomResources.SNSToSQSPolicy || {
      Type: 'AWS::SQS::QueuePolicy',
      Properties: {
        Queues: queueArns,
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Principal: '*',
            Action: 'sqs:SendMessage',
            Resource: '*',
            Condition: {
              ArnEquals: {
                'aws:SourceArn': topicArns
              }
            }
          }],
        }
      }
    };

    // Only create the policy if there are both topics and queues
    if (queueArns.length > 0 && topicArns.length > 0) {
      this.slsCustomResources.SNSToSQSPolicy = policy;
    }

  }

  startServer() {
    return new Promise(() => {
      Server.start(this.topics, this.stackPrefix);
      this.subscriptions.forEach(subscription => subscription.subscribe());
    });
  }

  injectOfflineEnv() {
    let env = [];
    if (Array.isArray(this.options.e)) {
      env = this.options.e;
    } else if (this.options.e) {
      env.push(this.options.e);
    }
    env.push(Server.endpointUrlEnvString);
    this.options.e = env;
  }
}


module.exports = ServerlessPluginPubSub;
