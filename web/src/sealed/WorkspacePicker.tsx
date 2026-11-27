import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  TextInput,
  Button,
} from '@bui/index'
import { useId, useRef, useState, type ChangeEvent } from 'react'
import type { Project, ProjectBinding } from '../../../src/project/types'
import type { MessageTarget, WorkspaceApi } from '../api'
import type { ExecutionNode } from '../types'

export function WorkspacePicker({
  api,
  taskId,
  disabled,
  onSelect,
  onSaved,
}: {
  api: WorkspaceApi
  taskId?: string
  disabled: boolean
  onSelect: (target: MessageTarget | undefined) => void
  onSaved: () => Promise<void>
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [nodes, setNodes] = useState<ExecutionNode[]>([])
  const [binding, setBinding] = useState<ProjectBinding>()
  const [choice, setChoice] = useState('default')
  const [directory, setDirectory] = useState('')
  const [nodeId, setNodeId] = useState('')
  const [name, setName] = useState('')
  const [label, setLabel] = useState(taskId ? '查看或更改' : '默认')
  const [error, setError] = useState('')
  const createId = useRef({ fingerprint: '', id: '' })
  const locked = disabled || busy

  async function load() {
    setBusy(true)
    setError('')
    try {
      const [saved, machines, current] = await Promise.all([
        api.projects(),
        api.executionNodes(),
        taskId ? api.taskProject(taskId) : undefined,
      ])
      setProjects(saved)
      setNodes(machines)
      setBinding(current)
      setNodeId(
        previous => current?.nodeId ?? (previous || (machines[0]?.id ?? '')),
      )
      if (current) {
        setChoice(
          current.projectId
            ? `project:${current.projectId}`
            : current.workingDirectory
              ? 'directory'
              : 'default',
        )
        setDirectory(current.workingDirectory ?? '')
        setLabel(current.workingDirectory ?? '默认')
      }
      setLoaded(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取目录失败')
    } finally {
      setBusy(false)
    }
  }

  function choose(value: string) {
    setChoice(value)
    setError('')
    const project = projects.find(item => `project:${item.id}` === value)
    setDirectory(project?.directory ?? '')
    if (project) setNodeId(project.nodeId)
  }

  async function save() {
    if (locked || !loaded) return
    setBusy(true)
    setError('')
    try {
      let project = projects.find(item => `project:${item.id}` === choice)
      if (choice === 'new') {
        const fingerprint = JSON.stringify([name, nodeId, directory])
        if (createId.current.fingerprint !== fingerprint)
          createId.current = { fingerprint, id: crypto.randomUUID() }
        project = await api.createProject({
          id: createId.current.id,
          name,
          nodeId,
          directory,
        })
        const created = project
        setProjects(current => [
          ...current.filter(item => item.id !== created.id),
          created,
        ])
        setChoice(`project:${project.id}`)
      }
      if (taskId) {
        const next = await api.updateTaskProject(taskId, {
          projectId: project?.id ?? null,
          ...(choice !== 'default'
            ? { workingDirectory: directory, nodeId: project?.nodeId ?? nodeId }
            : {}),
          expectedRevision: binding?.revision ?? 0,
        })
        setBinding(next)
        setLabel(next.workingDirectory ?? '默认')
        await onSaved()
      } else {
        onSelect(
          project
            ? { projectId: project.id }
            : choice === 'directory'
              ? { workspace: { directory, nodeId } }
              : undefined,
        )
        setLabel(project?.name ?? (choice === 'directory' ? directory : '默认'))
      }
      setOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存目录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto mb-2 w-full max-w-[1040px] text-[13px] text-ink-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        disabled={locked}
        onClick={() => {
          setOpen(value => !value)
          if (!open) void load()
        }}
        className="max-w-full truncate rounded-md px-2 py-1.5 hover:bg-accent-tint"
        title={label}
      >
        工作目录：{label}
      </button>
      {open && (
        <form
          id={`${id}-panel`}
          aria-label="工作目录设置"
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
          className="mt-2 grid gap-3 rounded-card border border-stroke-soft bg-surface p-3"
        >
          <p>
            {taskId
              ? '更改在后续执行生效。任务执行或等待审批时不能切换目录。'
              : '选择项目或普通文件夹，新消息将在所选目录开始一件事情。'}
          </p>
          <fieldset disabled={locked || !loaded} className="grid gap-3">
            <legend className="sr-only">目录选择</legend>
            <label htmlFor={`${id}-choice`}>位置</label>
            <Select
              name="location"
              value={choice}
              onValueChange={choose}
              disabled={locked || !loaded}
            >
              <SelectTrigger
                id={`${id}-choice`}
                className="h-10 w-full rounded-control bg-field"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">默认工作区</SelectItem>
                <SelectItem value="directory">
                  普通文件夹（无需创建项目）
                </SelectItem>
                {projects.map(project => (
                  <SelectItem key={project.id} value={`project:${project.id}`}>
                    {project.name}
                  </SelectItem>
                ))}
                <SelectItem value="new">登记项目…</SelectItem>
              </SelectContent>
            </Select>
            {choice !== 'default' && (
              <>
                {(choice === 'new' || choice === 'directory') && (
                  <>
                    <label htmlFor={`${id}-node`}>所在电脑</label>
                    <Select
                      name="node"
                      required
                      value={nodeId}
                      onValueChange={setNodeId}
                      disabled={locked || !loaded}
                    >
                      <SelectTrigger
                        id={`${id}-node`}
                        className="h-10 w-full rounded-control bg-field"
                      >
                        <SelectValue placeholder="选择电脑" />
                      </SelectTrigger>
                      <SelectContent>
                        {nodes.map(node => (
                          <SelectItem key={node.id} value={node.id}>
                            {node.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
                {choice === 'new' && (
                  <>
                    <label htmlFor={`${id}-name`}>项目名称</label>
                    <TextInput
                      id={`${id}-name`}
                      name="name"
                      required
                      maxLength={120}
                      value={name}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        setName(event.target.value)
                      }
                    />
                  </>
                )}
                <label htmlFor={`${id}-directory`}>该电脑上的完整目录</label>
                <TextInput
                  id={`${id}-directory`}
                  name="directory"
                  required
                  readOnly={
                    !taskId && choice !== 'directory' && choice !== 'new'
                  }
                  spellCheck={false}
                  autoCapitalize="none"
                  value={directory}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setDirectory(event.target.value)
                  }
                  aria-describedby={`${id}-help`}
                />
                <p id={`${id}-help`}>
                  例如资料夹或照片目录。不会移动文件；是否使用 worktree
                  由你的要求和目录内的规则决定。
                </p>
              </>
            )}
            <Button
              type="submit"
              className="justify-self-start rounded-md bg-accent-tint px-3 py-2"
            >
              {busy ? '保存中…' : '应用目录'}
            </Button>
          </fieldset>
          {error && <p role="alert">{error}</p>}
          {!loaded && !busy && (
            <button type="button" onClick={() => void load()}>
              重新读取
            </button>
          )}
        </form>
      )}
    </div>
  )
}
