const offline = process.env.PUBLIC_REFERENCE_GATSBY_OFFLINE === "1"

module.exports = {
  pathPrefix: "/contentful-gatsby-workflow-reference",
  siteMetadata: {
    title: "Northwind Field Notes",
  },
  plugins: offline ? [] : [{
    resolve: "gatsby-source-contentful",
    options: {
      accessToken: process.env.CONTENTFUL_DELIVERY_TOKEN,
      environment: "preview-sandbox",
      host: "cdn.contentful.com",
      spaceId: "demoSpace123",
    },
  }],
}
