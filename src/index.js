/**
 * A plugin for easier publish/subscribe patterns in the serverless framework
 */


const Promise = require('bluebird');

const { logWarning } = require('serverless/lib/classes/Error');

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
      'before:aws:package:finalize:mergeCustomProviderResources': this.generateResources.bind(this),
    };
  }



  /**
   * Generates custom resources for pubSub
   */
  generateResources(){
    const funcs = this.serverless.service.functions;


    const pubSubResources = {};
    const createTopicIfNotExists = (topicName) => {
      const topicLogicalId = this.naming.getTopicLogicalId(topicName);
      if (!pubSubResources[topicLogicalId]) {
        pubSubResources[topicLogicalId] = this.generateTopicResource(topicName);
      }
    };

    const createQueueIfNotExists = (queueName, warn) => {
      const queueLogicalId = this.naming.getActualQueueLogicalId(queueName);
      // If the queue has already been created, that indicates it has
      // multiple subscriptions, and we warn about competing polling.

      if (pubSubResources[queueLogicalId]) {
        if (warn) {
          logWarning(`[PubSub] ${queueName} has multiple subscriber functions that will compete for messages. Ignore this warning if that is intentional.`);
        }
      } else {
        pubSubResources[queueLogicalId] = this.generateQueueResource(queueName);
      }
    };

    const allowQueueSubscription = (topicName, queueName) => {
      const topicLogicalId = this.naming.getTopicLogicalId(topicName);
      const queueLogicalId = this.naming.getActualQueueLogicalId(queueName);
      const policy = pubSubResources.SNSToSQSPolicy || {
        Type: 'AWS::SQS::QueuePolicy',
          Properties: {
            Queues: [],
            PolicyDocument: {
              Version: '2012-10-17',
                Statement: [],
              }
            }
      };
      pubSubResources.SNSToSQSPolicy = policy;
      if (!policy.Properties.Queues.find(q => q.Ref === queueLogicalId)) {
        policy.Properties.Queues.push({Ref: queueLogicalId});
      }

      if (!policy.Properties.PolicyDocument.Statement.find(s => s.Condition.ArnEquals['aws:SourceArn'].Ref === topicLogicalId)) {
        policy.Properties.PolicyDocument.Statement.push({
          Effect: 'Allow',
          Principal: '*',
          Action: 'sqs:SendMessage',
          Resource: '*',
          Condition: {ArnEquals: {'aws:SourceArn': {Ref: topicLogicalId}}}
        });
      }
    };

    for (let funcKey in funcs) {
      const func = funcs[funcKey];
      for (let idx = 0; idx < (func.events || []).length; idx++) {
        let evt = func.events[idx],
          topic,
          queue = false,
          subscription,
          subLogicalId;
        // Skip events that are not pubSub
        if (!evt || !evt.pubSub) {
          continue;
        }


        // Pull pubsub config from event
        const {pubSub} = evt;

        // pubSub may be set to a string, in which case, we interpret
        // that as the topic name (and assume no queue config)
        if (typeof pubSub === 'string') {
          topic = pubSub;
        // If not, we pull topic and queue from their respective config
        } else {
          topic = pubSub.topic;
          queue = pubSub.queue;
          subscription = pubSub.subscription;
        }

        if (!topic) {
          throw Error(`No topic could be identified for pubSub subscription to ${funcKey}`);
        }

        createTopicIfNotExists(topic);

        if (queue) {
          let sourceMapping = {};
          if (queue === true) {
            queue = `${funcKey}-queue`;
          } else if (typeof queue !== 'string') {
            let {name, batchSize, enabled, startingPosition} = queue;
            queue = name;
            if (batchSize !== undefined) {
              sourceMapping.BatchSize = batchSize;
            }
            if (enabled !== undefined) {
              // Cast to string if boolean provided
              if (typeof enabled === 'boolean') {
                enabled = enabled ? 'True' : 'False';
              }
              sourceMapping.Enabled = enabled;
            }
            if (startingPosition !== undefined) {
              sourceMapping.StartingPosition = startingPosition;
            }
          }

          if (!queue) {
            throw Error(`[PubSub] Invalid queue name for function ${funcKey} / topic ${topic}`);
          }

          // Generate the queue CFM resource if it doesn't already exist
          createQueueIfNotExists(queue, true);
          const evtSrcLogicalId = this.naming.getQueueLogicalId(funcKey, queue);
          pubSubResources[evtSrcLogicalId] = this.generateQueueEventMapping(queue, funcKey, sourceMapping);

          subLogicalId = this.naming.getQueueSubscriptionLogicalId(topic, queue);
          pubSubResources[subLogicalId] = this.generateQueueSubscription(topic, queue, subscription);
          allowQueueSubscription(topic, queue);
        } else {
            subLogicalId = this.naming.getLambdaSnsSubscriptionLogicalId(funcKey, topic);
            pubSubResources[subLogicalId] =
            this.generateLambdaSubscription(topic, funcKey, subscription);
        }

      }
    }

    // Create any orphaned topics
    for (let topic in this.topics) {
      createTopicIfNotExists(topic);
    }

    // Create any orphaned queues
    for (let queue in this.queues) {
      createQueueIfNotExists(queue, false);
    }

    Object.assign(this.slsCustomResources, pubSubResources);
    return Promise.resolve();
  }

  generateQueueEventMapping(queue, func, propOverrides) {
    const props = {
      EventSourceArn: {'Fn::GetAtt': [this.naming.getActualQueueLogicalId(queue), 'Arn']},
      FunctionName: {Ref: this.naming.getLambdaLogicalId(func)},
      Enabled: 'True',
      BatchSize: 10,
    };
    return {
      Type: 'AWS::Lambda::EventSourceMapping',
      Properties: Object.assign(props, propOverrides)
    };
  }

  generateQueueSubscription(topic, queue, propOverrides) {
    const props = {
      TopicArn: this.formatTopicArn(topic),
      Protocol: 'sqs',
      Endpoint: {'Fn::GetAtt': [this.naming.getActualQueueLogicalId(queue), 'Arn']},
    };
    return {
      Type: 'AWS::SNS::Subscription',
      Properties: Object.assign(props, propOverrides)
    };
  }

  generateLambdaSubscription(topic, func, propOverrides) {
    const props = {
      TopicArn: this.formatTopicArn(topic),
      Protocol: 'lambda',
      Endpoint: {'Fn::GetAtt': [this.naming.getLambdaLogicalId(func), 'Arn']},
    };
    return {
      Type: 'AWS::SNS::Subscription',
      Properties: Object.assign(props, propOverrides)
    };
  }

  /**
   * Generates a CFM AWS::SQS::Queue Resource from the queue name
   * @param  {string} queue Queue name
   * @return {object}       AWS::SQS::Queue Resource
   */
  generateQueueResource(queue) {
    const propOverrides = this.queueConfig(queue);
    const props = {
      QueueName: this.namespaceResource(queue)
    };

    return {
      Type: 'AWS::SQS::Queue',
      Properties: Object.assign(props, propOverrides),
    };

  }

  /**
   * Generates a topic resource given the topic name
   * @param  {string} topic name of the topic
   * @return {object}       Cloudformation AWS::SNS::Topic
   */
  generateTopicResource(topic) {
    const propOverrides = this.topicConfig(topic);
    const props = {
      TopicName: this.namespaceResource(topic)
    };

    return {
      Type: 'AWS::SNS::Topic',
      Properties: Object.assign(props, propOverrides),
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
  get topics () {
    return (this.config && this.config.topics) || {};
  }

  /**
   * Gets the queues defined in the plugin configuration
   * @return {object} mapping of queue name and CFM resource
   */
  get queues () {
    return (this.config && this.config.queues) || {};
  }

  /**
   * Gets the configuration for a specific pubSub topic by name
   * @param  {string} topicName
   * @return {object}           Cloudformation AWS::SNS::Topic
   */
  topicConfig(topicName) {
    return this.topics[topicName] || {};
  }

  /**
   * Gets the configuration for a specific pubSub queue by name
   * @param  {string} topicName
   * @return {object}           Cloudformation AWS::SQS::Queue
   */
  queueConfig(queueName) {
    return this.queues[queueName] || {};
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
   * @return {string}]
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
    const topicResource = this.generateTopicResource(topic);
    return {
      'Fn::Join': [
        ':', [
          'arn',
          {Ref: 'AWS::Partition'},
          'sns',
          {Ref: 'AWS::Region'}, {Ref: 'AWS::AccountId'},
          topicResource.Properties.TopicName
        ]
      ]

    };
  }
}


module.exports = ServerlessPluginPubSub;
