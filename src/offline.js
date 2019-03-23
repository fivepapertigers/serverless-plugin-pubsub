/**
 * Offline capabilities for pubSub
 */


const bodyParser = require('body-parser');
const express = require('express');

const logger = require('./logger');
const { randomId } = require('./helpers');

/**
 * Offline server for subscribing local invocations to topics
 */
class Server {

  constructor() {
    this.port = '3100';
    this.host = 'localhost';
  }

  /**
   * Configure the offline server
   * @param  {string} options.port The port to run the server on
   * @param  {string} options.host The host name for the server
   */
  config({port, host}) {
    if (port) {
      this.port = port;
    }
    if (host) {
      this.host = host;
    }
  }

  /**
   * Starts the offline server
   * @param  {Topic[]} topics a list of available topics
   * @param  {string}  Prefix of the topic
   */
  start(topics, topicPrefix) {
    const app = express();
    app.use(bodyParser.urlencoded({extended: true}));
    app.all('/*', (req, res) => {
      if (req.body && req.body.Action === 'Publish') {
        const topicArn = req.body.TopicArn;
        const topicName = topicArn && topicArn
          // Remove ARN
          .split(':').slice(-1)[0]
          // Remove topic prefix
          .replace(topicPrefix, '');

        const message = req.body.Message;
        const messageId = randomId();
        const topic = topics.find(t => t.name === topicName);
        if (topic) {
          topic.publish(messageId, message);
          return res.status(200).set('content-type', 'application/xml').send(`
            <PublishResponse xmlns="https://sns.amazonaws.com/doc/2010-03-31/">
              <PublishResult>
                <MessageId>${messageId}</MessageId>
              </PublishResult>
              <ResponseMetadata>
                <RequestId>${randomId()}</RequestId>
              </ResponseMetadata>
            </PublishResponse>
          `);
        } else {
          logger.log(`Error: could not find a topic to match topic name ${topicName}`);
        }
      }
      return res.status(404).set('content-type', 'application/xml').send(`
        <ErrorResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">
          <Error>
            <Type>NotFound</Type>
            <Code>NotFound</Code>
            <Message>Topic not found</Message>
          </Error>
          <RequestId>${randomId()}</RequestId>
        </ErrorResponse>
      `);
    });
    app.listen(this.port, () => {
      logger.log(`Listening on port ${this.port}`);
    });
  }

  /**
   * Endpoint URL for the offline server
   * @return {string}
   */
  get endpointUrl() {
    return `http://${this.host}:${this.port}`;
  }

  /**
   * The environment string for the offline server
   * @return {string}
   */
  get endpointUrlEnvString() {
    return `SNS_ENDPOINT_URL=${this.endpointUrl}`;
  }
}

module.exports = new Server();
