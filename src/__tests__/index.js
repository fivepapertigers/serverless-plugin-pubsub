
const ServerlessPluginPubSub = require('../');

let sls;
let options;
let plugin;

const normalizeNameToAlphaNumericOnly = (name) => name.replace('-', '');

beforeEach(() => {
  sls = {
    service: {
      service: 'serviceName',
      functions: {
        foo: {
          handler: 'module.foo',
          environment: {
            PUBLISH_TOPIC: 'foo-happened'
          }
        },
        bar: {
          handler: 'module.bar',
          environment: {
            PUBLISH_TOPIC: 'bar-happened'
          },
          events: [{
            pubSub: {topic: 'foo-happened', queue: 'bar-queue'}
          }]
        },
        baz: {
          handler: 'module.baz',
          environment: {
            PUBLISH_TOPIC: 'baz-happened'
          },
          events: [{
            pubSub: 'foo-happened'
          }]
        },
      },
      resources: {},
      custom: {
        pubSub: {
          topics: {
            'foo-happened': {DisplayName: 'FooDefinitelyHappened'},
            'baz-happened': {}
          },
          queues: {
            'bar-queue': {DelaySeconds: 5},
          }
        },
      },
      provider: {},
    },
    getProvider: () => ({
      naming: {
        getQueueLogicalId: (func, queue) => `${normalizeNameToAlphaNumericOnly(queue)}To${func}`,
        getLambdaLogicalId: (funcName) => `${funcName}LogicalID`,
        getTopicLogicalId: (topicName) => `SNSTopic${normalizeNameToAlphaNumericOnly(topicName)}`,
        getLambdaSnsSubscriptionLogicalId: (func, topic) => `${normalizeNameToAlphaNumericOnly(topic)}To${func}`,
        normalizeNameToAlphaNumericOnly: normalizeNameToAlphaNumericOnly
      },

      getStage: () => 'stageName'
    }),
    variables: {
      getValueFromSource: () => ''
    }
  };
  plugin = new ServerlessPluginPubSub(sls, options);
});


describe('config getter', () => {

  test('should get the custom pubSub config', () => {
    expect(plugin.config).toEqual({
      topics: {
        'foo-happened': {DisplayName: 'FooDefinitelyHappened'},
        'baz-happened': {}
      },
      queues: {
        'bar-queue': {DelaySeconds: 5},
      }
    });
  });

  test('should get an empty object when no config', () => {
    delete plugin.serverless.service.custom;
    expect(plugin.config).toEqual({});
  });

});

describe('topics getter', () => {

  test('should get the custom pubSub topics config', () => {
    expect(plugin.topics).toEqual({
      'foo-happened': {DisplayName: 'FooDefinitelyHappened'},
      'baz-happened': {}
    });
  });

  test('should get an empty object when no config', () => {
    delete plugin.serverless.service.custom;
    expect(plugin.topics).toEqual({});
  });

});

describe('queues getter', () => {

  test('should get the custom pubSub queues config', () => {
    expect(plugin.queues).toEqual({
      'bar-queue': {DelaySeconds: 5},
    });
  });

  test('should get an empty object when no config', () => {
    delete plugin.serverless.service.custom;
    expect(plugin.queues).toEqual({});
  });

});

describe('topicConfig method', () => {

  test('should get the custom pubSub config for the topic', () => {
    expect(plugin.topicConfig('foo-happened')).toEqual({
      DisplayName: 'FooDefinitelyHappened',
    });
  });

  test('should get an empty object when no config', () => {
    delete plugin.serverless.service.custom;
    expect(plugin.topicConfig('foo-happened')).toEqual({});
  });

});

describe('queueConfig method', () => {

  test('should get the custom pubSub config for the queue', () => {
    expect(plugin.queueConfig('bar-queue')).toEqual({
      DelaySeconds: 5
    });
  });

  test('should get an empty object when no config', () => {
    delete plugin.serverless.service.custom;
    expect(plugin.queueConfig('bar-queue')).toEqual({});
  });

});

describe('generateTopicResource method', () => {

  test('should generate a new topic resource', () => {
    expect(plugin.generateTopicResource('bar-happened')).toEqual({
      Type: 'AWS::SNS::Topic',
      Properties: {
        TopicName: 'serviceName-stageName-bar-happened'
      }
    });
  });

  test('should override defaults with custom config', () => {
    expect(plugin.generateTopicResource('foo-happened')).toEqual({
      Type: 'AWS::SNS::Topic',
      Properties: {
        TopicName: 'serviceName-stageName-foo-happened',
        DisplayName: 'FooDefinitelyHappened',
      }
    });
  });

});

describe('generateQueueResource method', () => {

  test('should generate a new queue resource', () => {
    expect(plugin.generateQueueResource('default-queue')).toEqual({
      Type: 'AWS::SQS::Queue',
      Properties: {
        QueueName: 'serviceName-stageName-default-queue'
      }
    });
  });

  test('should override defaults with custom config', () => {
    expect(plugin.generateQueueResource('bar-queue')).toEqual({
      Type: 'AWS::SQS::Queue',
      Properties: {
        QueueName: 'serviceName-stageName-bar-queue',
        DelaySeconds: 5,
      }
    });
  });

});

describe('generateQueueSubscription method', () => {

  test('should generate a sns to sqs subscription resource', () => {
    expect(plugin.generateQueueSubscription('foo-happened', 'bar-queue')).toEqual({
      Type: 'AWS::SNS::Subscription',
      Properties: {
        TopicArn: {
          'Fn::Join': [
            ':', [
              'arn', {Ref: 'AWS::Partition'}, 'sns', {Ref: 'AWS::Region'}, {Ref: 'AWS::AccountId'},
              'serviceName-stageName-foo-happened'
            ]
          ]
        },
        Protocol: 'sqs',
        Endpoint: {'Fn::GetAtt': ['SQSQueuebarqueue', 'Arn']}
      }
    });
  });

  test('should generate a sns to sqs subscription resource with overrides', () => {
    expect(plugin.generateQueueSubscription('foo-happened', 'bar-queue', {RawMessageDelivery: true})).toEqual({
      Type: 'AWS::SNS::Subscription',
      Properties: {
        TopicArn: {
          'Fn::Join': [
            ':', [
              'arn', {Ref: 'AWS::Partition'}, 'sns', {Ref: 'AWS::Region'}, {Ref: 'AWS::AccountId'},
              'serviceName-stageName-foo-happened'
            ]
          ]
        },
        Protocol: 'sqs',
        RawMessageDelivery: true,
        Endpoint: {'Fn::GetAtt': ['SQSQueuebarqueue', 'Arn']}
      }
    });
  });

});


describe('generateResources method', () => {
  test('should generate all resources', async() => {
    await plugin.generateResources();
    expect(plugin.slsCustomResources).toEqual({
      SNSToSQSPolicy: {
        Properties: {
          PolicyDocument: {
            Statement: [
              {
                Action: 'sqs:SendMessage',
                Condition: {
                  ArnEquals: {
                    'aws:SourceArn': {
                      Ref: 'SNSTopicfoohappened'
                    }
                  }
                },
                Effect: 'Allow',
                Principal: '*',
                Resource: '*'
              }
            ],
            Version: '2012-10-17'
          },
          Queues: [
            {
              Ref: 'SQSQueuebarqueue'
            }
          ]
        },
        Type: 'AWS::SQS::QueuePolicy'
      },
      SNSTopicbazhappened: {
        Properties: {
          TopicName: 'serviceName-stageName-baz-happened'
        },
        Type: 'AWS::SNS::Topic'
      },
      SNSTopicfoohappened: {
        Properties: {
          DisplayName: 'FooDefinitelyHappened',
          TopicName: 'serviceName-stageName-foo-happened'
        },
        Type: 'AWS::SNS::Topic'
      },
      SQSQueuebarqueue: {
        Properties: {
          DelaySeconds: 5,
          QueueName: 'serviceName-stageName-bar-queue'
        },
        Type: 'AWS::SQS::Queue'
      },
      SQSQueuebarqueueToSNSTopicfoohappenedSubscription: {
        Properties: {
          Endpoint: {
            'Fn::GetAtt': [
              'SQSQueuebarqueue',
              'Arn'
            ]
          },
          Protocol: 'sqs',
          TopicArn: {
            'Fn::Join': [':', ['arn', {Ref: 'AWS::Partition'}, 'sns', {Ref: 'AWS::Region'}, {Ref: 'AWS::AccountId'}, 'serviceName-stageName-foo-happened']]
          }
        },
        Type: 'AWS::SNS::Subscription'
      },
    });
  });
});
