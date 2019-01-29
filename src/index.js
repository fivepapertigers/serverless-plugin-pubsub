/**
 * A plugin for easier publish/subscribe patterns in the serverless framework
 */


const Promise = require('bluebird');

const pubSubTopicSyntax = RegExp(/^pubSubTopic:/g);

const {
  Func, Topic, Queue, QueueToFuncSubscription,
  TopicToQueueSubscription, TopicToFuncSubscription
} = require('./models');


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

    // Note: getQueueLogicalId gets the event source mapping logical Id
    this.naming.getActualQueueLogicalId = (queueName) =>
        `SQSQueue${this.naming.normalizeNameToAlphaNumericOnly(queueName)}`;

    this.naming.getQueueSubscriptionLogicalId = (topicName, queueName) =>
        `${this.naming.getActualQueueLogicalId(queueName)}To${this.naming.getTopicLogicalId(topicName)}Subscription`;

    this.commands = {};
    this.hooks = {
      'after:package:initialize':
        () => {
          this.collectPubSubResourcesFromFunctions();
          this.collectPubSubResourcesFromCustomConfig();
          this.generateAdditionalEvents();
          this.generateAllCustomResources();
          this.allowLambdasToPublishSNS();
          this.allowSNSToSQSSubscriptions();
          return Promise.resolve();
        },
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
  getTopic(topicName) {
   return getOrSet(topicName, this.topics, () => new Topic({
        name: topicName, vendorConfig: this.customTopics[topicName] || {}
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
      name: funcName, serverlessConfig: funcConfig
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


        // Get or create the Topic resource
        const topic = this.getTopic(topicName);

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
    func.events.push({
      sns: {
        arn: this.formatTopicArn(sub.origin),
        topicName: this.namespaceResource(topicName)
      }
    });
  }

  /**
   * Generates all custom pubSub resources for the stack
   */
  generateAllCustomResources() {
    this.queues.forEach(q => this.generateSQSResource(q));
    this.topics.forEach(t => this.generateSNSResource(t));
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
      TopicArn: this.formatTopicArn(sub.origin),
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
    const serviceName = this.serverless.service.service;
    const stage = this.serverless.getProvider('aws').getStage();
    return `${serviceName}-${stage}-${resourceName}`;
  }

  /**
   * Returns the topic Arn as a Cloudformation join expression
   * @param  {string} topic the topic name
   * @return {object}       Cloudformation join expression that builds the Arn
   */
  formatTopicArn(topic) {
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
    const originalMethod = this.serverless.variables.getValueFromSource.bind(this.serverless.variables);
    const self = this;
    this.serverless.variables.getValueFromSource = function (variableString) {
      if (variableString.match(pubSubTopicSyntax)){
        const topicName = variableString.replace(pubSubTopicSyntax, '');
        const topic = self.getTopic(topicName);
        return self.formatTopicArn(topic);
      }
      return originalMethod(variableString);
    };
  }

  /**
   * Allows lambda to publish to the topics in the stack
   */
  allowLambdasToPublishSNS() {
    const statements = this.serverless.service.provider.iamRoleStatements || [];
    this.serverless.service.provider.iamRoleStatements = statements;

    statements.push(
      ...this.topics.map(t => ({
        Effect: 'Allow',
        Action: ['sns:Publish'],
        Resource: this.formatTopicArn(t)
      }))
    );
  }

  /**
   * Allows SQS queues to poll SNS topics
   */
  allowSNSToSQSSubscriptions() {
    const queueArns = unique(this.queues, (q) => q.name)
      .map(q => ({Ref: this.naming.getActualQueueLogicalId(q.name)}));

    const statements = unique(this.topics, (t) => t.name)
      .map(t => ({
        Effect: 'Allow',
        Principal: '*',
        Action: 'sqs:SendMessage',
        Resource: '*',
        Condition: {
          ArnEquals: {
            'aws:SourceArn': {Ref: this.naming.getTopicLogicalId(t.name)}
          }
        }
      }));

    const policy = {
      Type: 'AWS::SQS::QueuePolicy',
      Properties: {
        Queues: queueArns,
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: statements,
        }
      }
    };

    this.slsCustomResources.SNSToSQSPolicy = policy;
  }
}


module.exports = ServerlessPluginPubSub;
