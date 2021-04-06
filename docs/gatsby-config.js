const themeOptions = require('gatsby-theme-apollo-docs/theme-options');

module.exports = {
  pathPrefix: '/docs/federation',
  plugins: [
    {
      resolve: 'gatsby-theme-apollo-docs',
      options: {
        ...themeOptions,
        root: __dirname,
        subtitle: 'Apollo Federation',
        description: 'A guide to using Apollo Federation',
        githubRepo: 'apollographql/federation',
        sidebarCategories: {
          null: [
            'index',
          ],
          'Quickstart (Preview)': [
            'quickstart',
            'quickstart-pt-2',
            'quickstart-pt-3',
          ],
          'Core Concepts': [
            'implementing-services',
            'gateway',
            'entities',
            'value-types',
            'migrating-from-stitching',
          ],
          'Managed Federation': [
            'managed-federation/overview',
            'managed-federation/setup',
            'managed-federation/federated-schema-checks',
            'managed-federation/deployment',
            'managed-federation/monitoring',
          ],
          'Debugging': [
            'errors',
            'metrics',
          ],
          'Third-Party Support': [
            'other-servers',
            'federation-spec',
          ],
          'API Reference': [
            'api/apollo-federation',
            'api/apollo-gateway',
          ],
        },
      },
    },
  ],
};
