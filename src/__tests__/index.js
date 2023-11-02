
const ServerlessPluginPubSub = require('../');

let sls;
let options;
let plugin;

const normalizeNameToAlphaNumericOnly = (name) => name.replace(/-/g, '');

beforeEach(() => {
  sls = {
    processedInput: {
      commands: [],
    },
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
            pubSub: {
              topic: {
                name: 'foo-happened',
                subscription: {
                  DeliveryPolicy: {
                    throttlePolicy: {maxReceivesPerSecond: 3}
                  }
                }
              },
              queue: {
                name: 'bar-queue',
                subscription: {
                  BatchSize: 1
                }
              }
            }
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
        handleExtEvt: {
          handler: 'module.handleExtEvt',
          events: [{
            pubSub: {
              topic: {
                name: 'some-external-topic',
                arn: 'arn:aws:sns:us-east-1:10101010:some-external-topic',
              },
              queue: true
            }
          }]
        }
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
          },
          defaults: {
            queues: {
              VisibilityTimeout: 4000,
            },
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
      },
      defaults: {
        queues: {
          VisibilityTimeout: 4000,
        },
      }
    });
  });

  test('should get an empty object when no config', () => {
    delete plugin.serverless.service.custom;
    expect(plugin.config).toEqual({});
  });

});

describe('customTopics getter', () => {

  test('should get the custom pubSub topics config', () => {
    expect(plugin.customTopics).toEqual({
      'foo-happened': {DisplayName: 'FooDefinitelyHappened'},
      'baz-happened': {}
    });
  });

  test('should get an empty object when no config', () => {
    delete plugin.serverless.service.custom;
    expect(plugin.customTopics).toEqual({});
  });

});

describe('customQueues getter', () => {

  test('should get the custom pubSub queues config', () => {
    expect(plugin.customQueues).toEqual({
      'bar-queue': {DelaySeconds: 5},
    });
  });

  test('should get an empty object when no config', () => {
    delete plugin.serverless.service.custom;
    expect(plugin.customQueues).toEqual({});
  });

});

describe('collectPubSubResourcesFromFunctions', () => {

  test('should get all resources', () => {
    plugin.collectPubSubResourcesFromFunctions();
    expect(plugin.topics.length).toEqual(2);
    expect(plugin.topics[0].name).toEqual('foo-happened');
    expect(plugin.topics[1].name).toEqual('some-external-topic');
    expect(plugin.queues.length).toEqual(2);
    expect(plugin.queues[0].name).toEqual('bar-queue');
    expect(plugin.queues[1].name).toEqual('handleExtEvt-queue');
    expect(plugin.subscriptions.length).toEqual(5);
  });
});


describe('generateResources method', () => {
  test('should generate all resources', async() => {
    await plugin.hooks['after:package:initialize']();
    expect(plugin.slsCustomResources).toEqual({
      SNSToSQSPolicy: {
        Properties: {
          PolicyDocument: {
            Statement: [
              {
                Action: 'sqs:SendMessage',
                Condition: {
                  ArnEquals: {
                    'aws:SourceArn': [
                      { Ref: 'SNSTopicfoohappened' },
                      'arn:aws:sns:us-east-1:10101010:some-external-topic',
                      { Ref: 'SNSTopicbazhappened' }
                     ]
                  }
                },
                Effect: 'Allow',
                Principal: '*',
                Resource: '*'
              },
            ],
            Version: '2012-10-17'
          },
          Queues: [
            {
              Ref: 'SQSQueuebarqueue'
            },
            {
              Ref: 'SQSQueuehandleExtEvtqueue'
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
          QueueName: 'serviceName-stageName-bar-queue',
          VisibilityTimeout: 4000,
        },
        Type: 'AWS::SQS::Queue'
      },
      SQSQueuehandleExtEvtqueue: {
        Properties: {
          QueueName: 'serviceName-stageName-handleExtEvt-queue',
          VisibilityTimeout: 4000,
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
          DeliveryPolicy: {
            throttlePolicy: {
              maxReceivesPerSecond: 3,
            },
          },
          Protocol: 'sqs',
          TopicArn: {
            Ref: 'SNSTopicfoohappened',
          }
        },
        Type: 'AWS::SNS::Subscription'
      },
      SQSQueuebarqueueTobar: {
        Type: 'AWS::Lambda::EventSourceMapping',
        Properties: {
          BatchSize: 1,
          EventSourceArn: {
           'Fn::GetAtt': ['SQSQueuebarqueue', 'Arn'],
          },
          FunctionName: {
            'Fn::GetAtt': ['barLogicalID', 'Arn']
          }
        },
      },
      foohappenedTobaz: {
        Properties: {
          Endpoint: {
            'Fn::GetAtt': [
              'bazLogicalID',
              'Arn',
            ],
          },
          Protocol: 'lambda',
          TopicArn: {
            Ref: 'SNSTopicfoohappened',
          },
        },
        Type: 'AWS::SNS::Subscription',
      },
      SQSQueuehandleExtEvtqueueToSNSTopicsomeexternaltopicSubscription: {
        Type: 'AWS::SNS::Subscription',
        Properties: {
          Endpoint: {
            'Fn::GetAtt': [
              'SQSQueuehandleExtEvtqueue',
              'Arn'
            ]
          },
          Protocol: 'sqs',
          TopicArn: 'arn:aws:sns:us-east-1:10101010:some-external-topic'
        }
      },
      SQSQueuehandleExtEvtqueueTohandleExtEvt: {
        Type: 'AWS::Lambda::EventSourceMapping',
        Properties: {
          EventSourceArn: {
           'Fn::GetAtt': ['SQSQueuehandleExtEvtqueue', 'Arn'],
          },
          FunctionName: {
            'Fn::GetAtt': ['handleExtEvtLogicalID', 'Arn']
          }
        },
      }
    });
  });
});


describe('allowLambdasToPublishSNS method', () => {
  test('should generate a statement for each topic', async() => {
    await plugin.hooks['after:package:initialize']();
    expect(sls.service.provider.iamRoleStatements).toEqual([
      {
        Action: ['sns:Publish'],
        Effect: 'Allow',
        Resource: [
          {
            'Fn::Join': [
              ':',
              [
                'arn',
                {Ref: 'AWS::Partition'},
                'sns',
                {Ref: 'AWS::Region'},
                {Ref: 'AWS::AccountId'},
                'serviceName-stageName-foo-happened'
              ]
            ]
          },
          'arn:aws:sns:us-east-1:10101010:some-external-topic',
          {
            'Fn::Join': [
              ':',
              [
                'arn',
                {Ref: 'AWS::Partition'},
                'sns',
                {Ref: 'AWS::Region'},
                {Ref: 'AWS::AccountId'},
                'serviceName-stageName-baz-happened'
              ]
            ]
          }
        ]
      }
    ]);
  });
});

describe('pubSubTopic variable', () => {
  test('is replaced correctly in online mode', async() => {
    expect(
        await plugin.configurationVariablesSources.pubSubTopic.resolve({
        address: 'my-topic'
      })
    ).toEqual({
      value: {
        'Fn::Join': [
          ':', [
            'arn',
            {Ref: 'AWS::Partition'},
            'sns',
            {Ref: 'AWS::Region'}, {Ref: 'AWS::AccountId'},
            'serviceName-stageName-my-topic'
          ]
        ]
      }
    });
  });
  test('is replaced correctly in offline mode', async() => {
    plugin.offlineMode = true;
    expect(
        await plugin.configurationVariablesSources.pubSubTopic.resolve({
          address: 'my-topic'
        })
    ).toEqual({
      value: 'arn:aws:sns:us-east-1:1234567890123:serviceName-stageName-my-topic'
    });
  });
});
