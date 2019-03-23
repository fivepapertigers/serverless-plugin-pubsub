
const AWS = require('aws-sdk');

/**
 * The SNS client, pointing to the SNS_ENDPOINT_URL for local runtime
 * (if provided)
 */
const SNS = new AWS.SNS({
  endpoint: process.env.SNS_ENDPOINT_URL || undefined
});

/**
 * A generic environment variable where new messages should be published.
 */
const PUBLISH_TOPIC = process.env.PUBLISH_TOPIC;


/**
 * A generic publishing function that JSON encodes a message and publishes
 * to the PUBLISH_TOPIC
 * @async
 * @param  {object} msg   A JSON-serializable message object
 */
const publish = async (msg) => await SNS.publish({
  Message: JSON.stringify(msg),
  TopicArn: PUBLISH_TOPIC
}).promise();


module.exports = {
  foo: async () => await publish({foo: true}),
  bar: async () => await publish({bar: true}),
  baz: async () => await publish({baz: true}),
};
