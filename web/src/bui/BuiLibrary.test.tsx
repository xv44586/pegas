// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import '../test-env'
import {
  Button,
  Checkbox,
  CommandPalette,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  RadioGroup,
  RadioItem,
  SegmentedControl,
  StatusPill,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TextRow,
  ValuePill,
} from './index'

afterEach(cleanup)

describe('BUI component library', () => {
  it('renders the pill button variants with press feedback classes', () => {
    render(
      <div className="bui">
        <Button variant="accent">重试提交</Button>
        <Button variant="secondary">去决定</Button>
        <Button variant="quiet" size="sm">
          查看
        </Button>
      </div>,
    )
    const accent = screen.getByRole('button', { name: '重试提交' })
    expect(accent.className).toContain('bg-accent')
    expect(accent.className).toContain('rounded-full')
    expect(accent.className).toContain('active:scale-[0.96]')
    expect(screen.getByRole('button', { name: '去决定' }).className).toContain(
      'shadow-btn',
    )
  })

  it('keeps status and value pills on the AA text tones', () => {
    render(
      <div className="bui">
        <StatusPill tone="green">已完成</StatusPill>
        <StatusPill tone="red">执行失败</StatusPill>
        <ValuePill tone="orange">需要你决定</ValuePill>
      </div>,
    )
    expect(screen.getByText('已完成').className).toContain('text-green-text')
    expect(screen.getByText('执行失败').className).toContain('text-red-text')
    expect(screen.getByText('需要你决定').className).toContain(
      'text-orange-text',
    )
  })

  it('drives the segmented control and switch through callbacks', () => {
    const onSegment = vi.fn()
    const onSwitch = vi.fn()
    render(
      <div className="bui">
        <SegmentedControl
          options={['浅色', '深色']}
          value="浅色"
          onChange={onSegment}
        />
        <Switch checked={false} onChange={onSwitch} label="自动审阅" />
      </div>,
    )
    fireEvent.click(screen.getByRole('tab', { name: '深色' }))
    expect(onSegment).toHaveBeenCalledWith('深色')
    fireEvent.click(screen.getByRole('switch', { name: '自动审阅' }))
    expect(onSwitch).toHaveBeenCalledWith(true)
  })

  it('renders label/value rows', () => {
    render(
      <div className="bui">
        <TextRow label="本周执行" value="23 次" meta="+8%" />
      </div>,
    )
    expect(screen.getByText('本周执行')).toBeTruthy()
    expect(screen.getByText('23 次')).toBeTruthy()
    expect(screen.getByText('+8%')).toBeTruthy()
  })

  it('opens a radix dialog with BUI surface styling and Escape close', () => {
    render(
      <div className="bui">
        <Dialog>
          <DialogTrigger asChild>
            <Button>删除自动化</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>确认删除？</DialogTitle>
          </DialogContent>
        </Dialog>
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: '删除自动化' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('rounded-window')
    expect(dialog.className).toContain('shadow-overlay')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('toggles checkbox and radio group with keyboard-accessible radix behavior', () => {
    function Harness() {
      const [checked, setChecked] = useState(false)
      const [choice, setChoice] = useState('keep')
      return (
        <div className="bui">
          <Checkbox
            aria-label="保留触发记录"
            checked={checked}
            onCheckedChange={value => setChecked(value === true)}
          />
          <RadioGroup value={choice} onValueChange={setChoice}>
            <RadioItem aria-label="保留全部记录" value="keep" />
            <RadioItem aria-label="全部清除" value="clear" />
          </RadioGroup>
        </div>
      )
    }
    render(<Harness />)
    const checkbox = screen.getByRole('checkbox', { name: '保留触发记录' })
    fireEvent.click(checkbox)
    expect(checkbox.getAttribute('data-state')).toBe('checked')
    fireEvent.click(screen.getByRole('radio', { name: '全部清除' }))
    expect(
      screen
        .getByRole('radio', { name: '全部清除' })
        .getAttribute('data-state'),
    ).toBe('checked')
  })

  it('switches radix tabs panels', () => {
    render(
      <div className="bui">
        <Tabs defaultValue="model">
          <TabsList>
            <TabsTrigger value="model">模型</TabsTrigger>
            <TabsTrigger value="behavior">行为</TabsTrigger>
          </TabsList>
          <TabsContent value="model">模型面板</TabsContent>
          <TabsContent value="behavior">行为面板</TabsContent>
        </Tabs>
      </div>,
    )
    expect(screen.getByText('模型面板')).toBeTruthy()
    fireEvent.mouseDown(screen.getByRole('tab', { name: '行为' }))
    fireEvent.click(screen.getByRole('tab', { name: '行为' }))
    expect(screen.getByText('行为面板')).toBeTruthy()
    expect(screen.queryByText('模型面板')).toBeNull()
  })

  it('filters command palette items through cmdk', () => {
    render(
      <CommandPalette open onOpenChange={() => undefined} title="全局搜索">
        <CommandInput placeholder="搜索事情" />
        <CommandList>
          <CommandItem value="安全自更新流程">安全自更新流程</CommandItem>
          <CommandItem value="周报摘要">周报摘要</CommandItem>
        </CommandList>
      </CommandPalette>,
    )
    const input = screen.getByPlaceholderText('搜索事情')
    fireEvent.change(input, { target: { value: '周报' } })
    expect(screen.queryByText('安全自更新流程')).toBeNull()
    expect(screen.getByText('周报摘要')).toBeTruthy()
  })
})
