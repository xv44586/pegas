export interface Project {
  id: string
  userId: string
  name: string
  nodeId: string
  directory: string
  createdAt: string
}

export interface ProjectBinding {
  projectId: string | null
  workingDirectory: string | null
  nodeId: string | null
  revision: number
}
