
const AWS = require('aws-sdk');

const SNS = new AWS.SNS();

const PUBLISH_TOPIC = process.env.PUBLISH_TOPIC;

const publish = async (msg) => await SNS.publish({
  Message: JSON.stringify(msg),
  TopicArn: PUBLISH_TOPIC
}).promise();

module.exports = {
  foo: async () => await publish({foo: true}),
  bar: async () => await publish({bar: true}),
  baz: async () => await publish({baz: true}),
  handleExtEvent: async (event) => console.log(event)
};
