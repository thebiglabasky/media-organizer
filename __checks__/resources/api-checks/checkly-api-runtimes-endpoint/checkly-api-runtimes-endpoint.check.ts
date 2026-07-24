import { AlertChannel, AlertEscalationBuilder, ApiCheck, AssertionBuilder, Frequency, RetryStrategyBuilder } from 'checkly/constructs'

new ApiCheck('checkly-api-runtimes-endpoint-N3Bf6F0g', {
  name: 'Checkly API - Runtimes Endpoint',
  degradedResponseTime: 5000,
  maxResponseTime: 20000,
  activated: true,
  locations: [
    'us-east-1',
    'eu-west-1',
  ],
  frequency: Frequency.EVERY_1M,
  alertChannels: [
    AlertChannel.fromId(283583),
    AlertChannel.fromId(287243),
  ],
  alertEscalationPolicy: AlertEscalationBuilder.runBasedEscalation(1, {
    amount: 0,
    interval: 5,
  }, {
    enabled: false,
    percentage: 10,
  }),
  retryStrategy: RetryStrategyBuilder.noRetries(),
  request: {
    url: 'https://api.checklyhq.com/v1/runtimes',
    method: 'GET',
    assertions: [
      AssertionBuilder.statusCode().equals(200),
      AssertionBuilder.jsonBody('$.length').greaterThan('0'),
    ],
  },
})
