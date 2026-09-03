export interface IdentifiedResource {
  sys: {
    id: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface ContentfulLink {
  id: string
  linkType: string
}

export interface ProjectConfig {
  spaceId: string
  previewEnvironment: string
  defaultLocale: string
}

export interface ProjectProfile extends ProjectConfig {
  gatsbyRepositoryPath: string
  productionAlias: string
  productionEnvironment: string
  reviewPort: number
}
