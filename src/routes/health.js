import { Elysia } from 'elysia'

export default new Elysia().get('/health', () => new Response('☕'), {
  detail: {
    description: 'Health check to verify the service is running.',
    responses: {
      200: { content: { 'text/plain': { schema: { example: '☕', type: 'string' } } }, description: 'Service is healthy' },
    },
    summary: 'Health check',
    tags: ['Health'],
  },
})
