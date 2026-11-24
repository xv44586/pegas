import { Button } from '@bui/index'
import { Check, ChevronDown, RotateCw, Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { DshModelCatalogItem } from '../types'

export const MODEL_PICKER_PAGE_SIZE = 30

export interface ModelPickerFixedOption {
  value: string
  label: string
  hint?: string
}

export interface ModelPickerSelection {
  key: string
  label: string
  detail?: string
}

export function modelSelectionKey(model: DshModelCatalogItem): string {
  return `${model.provider}::${model.id}`
}

export function modelSearchRank(
  model: Pick<DshModelCatalogItem, 'name' | 'id'>,
  normalizedQuery: string,
): number {
  const name = model.name.toLocaleLowerCase()
  const id = model.id.toLocaleLowerCase()
  const idTail = id.slice(id.lastIndexOf('/') + 1)
  if (name.startsWith(normalizedQuery) || idTail.startsWith(normalizedQuery))
    return 0
  if (name.includes(normalizedQuery) || idTail.includes(normalizedQuery))
    return 1
  if (id.startsWith(normalizedQuery)) return 2
  return 3
}

export function ModelPicker({
  ariaLabel,
  models,
  value,
  onSelect,
  fixedOptions = [],
  title = '选择模型',
  description = '已配置模型服务的完整目录',
  footer,
  placeholder = '选择模型',
  placeholderDetail,
  disabled = false,
  variant = 'field',
  openRequest = 0,
}: {
  ariaLabel: string
  models: DshModelCatalogItem[]
  value: string
  onSelect: (value: string, model?: DshModelCatalogItem) => Promise<void> | void
  fixedOptions?: ModelPickerFixedOption[]
  title?: string
  description?: string
  footer?: string
  placeholder?: string
  placeholderDetail?: string
  disabled?: boolean
  variant?: 'field' | 'composer'
  openRequest?: number
}) {
  const pickerId = useId()
  const pickerTitleId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [savingKey, setSavingKey] = useState('')
  const [error, setError] = useState('')
  const [placement, setPlacement] = useState<'down' | 'up'>('down')
  const [maxPanelHeight, setMaxPanelHeight] = useState<number>()
  const controlRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const fixed = fixedOptions.find(option => option.value === value)
  const selectedModel = models.find(model => modelSelectionKey(model) === value)
  const selection: ModelPickerSelection | undefined = selectedModel
    ? {
        key: value,
        label: selectedModel.name,
        detail: `${selectedModel.provider}${
          selectedModel.id !== selectedModel.name
            ? ` · ${selectedModel.id}`
            : ''
        }`,
      }
    : fixed
      ? { key: value, label: fixed.label, detail: fixed.hint }
      : undefined
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredFixed = useMemo(
    () =>
      normalizedQuery
        ? fixedOptions.filter(option =>
            `${option.label} ${option.hint ?? ''}`
              .toLocaleLowerCase()
              .includes(normalizedQuery),
          )
        : fixedOptions,
    [fixedOptions, normalizedQuery],
  )
  const filteredModels = useMemo(() => {
    if (!normalizedQuery) {
      const current = models.find(model => modelSelectionKey(model) === value)
      return current
        ? [current, ...models.filter(model => model !== current)]
        : models
    }
    return models
      .filter(model =>
        `${model.name} ${model.id} ${model.provider}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
      .map((model, index) => ({
        model,
        index,
        rank: modelSearchRank(model, normalizedQuery),
      }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map(entry => entry.model)
  }, [models, normalizedQuery, value])
  const pageSize = MODEL_PICKER_PAGE_SIZE
  const pageCount = Math.max(1, Math.ceil(filteredModels.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pageModels = filteredModels.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  )
  const selectedInPage = pageModels.some(
    model => modelSelectionKey(model) === value,
  )

  function closePicker(restoreFocus = true) {
    setOpen(false)
    setQuery('')
    setPage(0)
    setError('')
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0)
  }

  function openPicker() {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom
      const spaceAbove = rect.top
      const openUp = spaceBelow < 360 && spaceAbove > spaceBelow
      setPlacement(openUp ? 'up' : 'down')
      setMaxPanelHeight(
        Math.max(220, Math.min(520, (openUp ? spaceAbove : spaceBelow) - 16)),
      )
    }
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    window.setTimeout(() => searchRef.current?.focus(), 0)
    const dismiss = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (controlRef.current?.contains(target)) return
      closePicker(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      closePicker()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  useEffect(() => {
    if (!openRequest || disabled || emptyCatalog) return
    triggerRef.current?.scrollIntoView({ block: 'nearest' })
    openPicker()
  }, [openRequest])

  function focusOption(index: number) {
    const options = Array.from(
      pickerRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    )
    if (!options.length) return
    options[Math.max(0, Math.min(index, options.length - 1))]?.focus()
  }

  async function selectValue(nextValue: string, model?: DshModelCatalogItem) {
    if (savingKey || nextValue === value) {
      closePicker()
      return
    }
    setSavingKey(nextValue)
    setError('')
    try {
      await onSelect(nextValue, model)
      closePicker()
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : '模型切换失败，请重试。',
      )
    } finally {
      setSavingKey('')
    }
  }

  const emptyCatalog = !models.length && !fixedOptions.length
  return (
    <div
      className={`model-picker-control bui relative${variant === 'composer' ? ' composer-model-control' : ''}`}
      ref={controlRef}
    >
      <button
        aria-controls={pickerId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${selection?.label ?? placeholder}${selection?.detail ?? ''}，${ariaLabel}`}
        className={
          variant === 'composer'
            ? 'composer-model-button flex h-[38px] w-auto max-w-[min(290px,34vw)] items-center justify-between gap-1 rounded-control px-2 pl-2.5 text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink aria-expanded:bg-surface aria-expanded:text-ink [&[aria-expanded=true]>svg]:rotate-180 max-[820px]:max-w-[150px]'
            : 'model-picker-trigger flex min-h-10 w-full items-center justify-between gap-2.5 rounded-control bg-field px-3 py-1.5 text-left text-ink shadow-inset-field transition-shadow duration-150 hover:bg-field focus-visible:shadow-[0_0_0_1px_var(--accent)] aria-expanded:shadow-[0_0_0_1px_var(--accent)] disabled:cursor-not-allowed disabled:bg-inset disabled:text-ink-2 [&[aria-expanded=true]>svg]:rotate-180'
        }
        disabled={disabled || emptyCatalog}
        onClick={() => {
          if (open) closePicker(false)
          else openPicker()
        }}
        ref={triggerRef}
        title={selection?.label ?? placeholder}
        type="button"
        onKeyDown={event => {
          if (event.key === 'Escape' && open) {
            event.preventDefault()
            closePicker()
          }
        }}
      >
        <span className="grid min-w-0 gap-px">
          <strong
            className={`truncate font-medium ${variant === 'composer' ? 'text-[13px]' : 'text-[14px]'}`}
          >
            {selection?.label ?? placeholder}
          </strong>
          {(selection?.detail ?? placeholderDetail) && (
            <small className="truncate text-[11px] font-normal text-ink-2">
              {selection?.detail ?? placeholderDetail}
            </small>
          )}
        </span>
        <ChevronDown
          className="shrink-0 text-ink-3 transition-transform duration-150"
          size={16}
        />
      </button>
      {open && (
        <div
          aria-labelledby={pickerTitleId}
          className={`composer-model-picker model-picker-panel absolute grid auto-rows-auto gap-2.5 overflow-hidden rounded-window bg-surface p-2.5 pt-4 shadow-overlay [grid-template-rows:auto_auto_minmax(0,1fr)] ${
            variant === 'composer'
              ? 'is-composer bottom-12 right-0 z-[45] w-[min(440px,calc(100vw-72px))] max-h-[min(520px,calc(100dvh-280px))] origin-bottom-right max-[820px]:fixed max-[820px]:inset-x-3.5 max-[820px]:bottom-[82px] max-[820px]:w-auto max-[820px]:max-h-[min(460px,calc(100dvh-260px))]'
              : `left-0 z-[60] w-[min(440px,calc(100vw-48px))] max-h-[min(520px,calc(100dvh-160px))] ${placement === 'up' ? 'is-up bottom-[calc(100%+6px)] origin-bottom-left' : 'top-[calc(100%+6px)] origin-top-left'}`
          }`}
          id={pickerId}
          style={
            variant === 'composer' || maxPanelHeight === undefined
              ? undefined
              : { maxBlockSize: maxPanelHeight }
          }
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              closePicker()
              return
            }
            const target = event.target
            if (event.key === 'ArrowDown' && target === searchRef.current) {
              event.preventDefault()
              focusOption(0)
              return
            }
            if (!(target instanceof HTMLElement)) return
            const options = Array.from(
              pickerRef.current?.querySelectorAll<HTMLElement>(
                '[role="option"]',
              ) ?? [],
            )
            const currentIndex = options.indexOf(target)
            if (currentIndex < 0) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const step = event.key === 'ArrowDown' ? 1 : -1
              focusOption(
                (currentIndex + step + options.length) % options.length,
              )
            } else if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault()
              focusOption(event.key === 'Home' ? 0 : options.length - 1)
            } else if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              target.click()
            }
          }}
          ref={pickerRef}
          role="dialog"
        >
          <header className="flex items-start justify-between gap-4 px-2">
            <div>
              <h2 className="text-[16px] tracking-[-0.02em]" id={pickerTitleId}>
                {title}
              </h2>
              <p className="mt-1 text-[12px] text-ink-2">{description}</p>
            </div>
            <span className="mt-1 text-[12px] text-ink-2">
              {models.length} 个可用
            </span>
          </header>
          <label className="composer-model-search bui mx-0.5 flex h-10 items-center gap-2 rounded-control bg-field px-3 shadow-hairline transition-shadow duration-150 focus-within:bg-surface focus-within:shadow-[0_0_0_1px_var(--accent)]">
            <Search className="shrink-0 text-ink-3" size={16} />
            <span className="visually-hidden">搜索模型</span>
            <input
              autoComplete="off"
              className="min-w-0 flex-1 appearance-none bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
              onChange={event => {
                setQuery(event.target.value)
                setPage(0)
              }}
              placeholder="搜索模型"
              ref={searchRef}
              spellCheck={false}
              type="search"
              value={query}
            />
          </label>
          <div
            aria-label="可用模型"
            className="composer-model-list grid min-h-0 gap-0.5 overflow-y-auto overscroll-contain px-0.5 [scrollbar-width:thin]"
            role="listbox"
          >
            {filteredFixed.map(option => {
              const isSelected = option.value === value
              const isSaving = savingKey === option.value
              return (
                <div
                  aria-disabled={Boolean(savingKey)}
                  aria-selected={isSelected}
                  className="composer-model-option is-fixed grid min-h-12 cursor-pointer items-center gap-3 rounded-control rounded-b-none border-b border-line px-2.5 py-2 [grid-template-columns:minmax(0,1fr)_20px] transition-colors duration-100 hover:bg-hover focus-visible:bg-hover focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] focus-visible:outline-none aria-selected:bg-accent-tint aria-disabled:cursor-wait aria-disabled:opacity-60"
                  data-value={option.value}
                  key={`fixed:${option.value}`}
                  onClick={() => {
                    if (!savingKey) void selectValue(option.value)
                  }}
                  role="option"
                  tabIndex={isSelected ? 0 : -1}
                >
                  <span className="grid min-w-0 gap-0.5">
                    <strong className="truncate text-[14px] font-medium">
                      {option.label}
                    </strong>
                    {option.hint && (
                      <small className="truncate text-[11px] text-ink-2">
                        {option.hint}
                      </small>
                    )}
                  </span>
                  {isSaving ? (
                    <RotateCw
                      className="is-spinning animate-spin text-ink-2 [animation-duration:900ms]"
                      size={17}
                    />
                  ) : (
                    isSelected && (
                      <Check className="text-accent-ink" size={18} />
                    )
                  )}
                </div>
              )
            })}
            {pageModels.length
              ? pageModels.map((model, index) => {
                  const key = modelSelectionKey(model)
                  const isSelected = key === value
                  const isSaving = savingKey === key
                  return (
                    <div
                      aria-disabled={Boolean(savingKey)}
                      aria-selected={isSelected}
                      className="composer-model-option grid min-h-12 cursor-pointer items-center gap-3 rounded-control px-2.5 py-2 [grid-template-columns:minmax(0,1fr)_20px] transition-colors duration-100 hover:bg-hover focus-visible:bg-hover focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] focus-visible:outline-none aria-selected:bg-accent-tint aria-disabled:cursor-wait aria-disabled:opacity-60"
                      data-model-id={model.id}
                      key={key}
                      onClick={() => {
                        if (!savingKey) void selectValue(key, model)
                      }}
                      role="option"
                      tabIndex={
                        isSelected ||
                        (!selectedInPage &&
                          !filteredFixed.length &&
                          currentPage === 0 &&
                          index === 0)
                          ? 0
                          : -1
                      }
                    >
                      <span className="grid min-w-0 gap-0.5">
                        <strong className="truncate text-[14px] font-medium">
                          {model.name}
                        </strong>
                        <small className="truncate text-[11px] text-ink-2">
                          {model.provider}
                          {model.id !== model.name ? ` · ${model.id}` : ''}
                        </small>
                      </span>
                      {isSaving ? (
                        <RotateCw
                          className="is-spinning animate-spin text-ink-2 [animation-duration:900ms]"
                          size={17}
                        />
                      ) : (
                        isSelected && (
                          <Check className="text-accent-ink" size={18} />
                        )
                      )}
                    </div>
                  )
                })
              : !filteredFixed.length && (
                  <p className="composer-model-empty px-2.5 py-6 text-center text-ink-2">
                    没有匹配的模型
                  </p>
                )}
          </div>
          {filteredModels.length > pageSize && (
            <div className="composer-model-pagination pagination bui mx-0.5 mt-0 flex items-center gap-2">
              <span className="flex-1 text-[11px] text-ink-2">
                {currentPage * pageSize + 1}–
                {Math.min((currentPage + 1) * pageSize, filteredModels.length)}{' '}
                / {filteredModels.length}
              </span>
              <Button
                className="h-[30px] flex-none rounded-control px-3 text-[13px] whitespace-nowrap"
                disabled={currentPage === 0}
                onClick={() => setPage(Math.max(0, currentPage - 1))}
                size="sm"
                type="button"
                variant="secondary"
              >
                上一页
              </Button>
              <Button
                className="h-[30px] flex-none rounded-control px-3 text-[13px] whitespace-nowrap"
                disabled={currentPage >= pageCount - 1}
                onClick={() =>
                  setPage(Math.min(pageCount - 1, currentPage + 1))
                }
                size="sm"
                type="button"
                variant="secondary"
              >
                下一页
              </Button>
            </div>
          )}
          {error && (
            <p
              className="composer-model-error rounded-control bg-red-tint px-2.5 py-2 text-[13px] text-red-text"
              role="alert"
            >
              {error}
            </p>
          )}
          {footer && (
            <footer className="border-t border-line px-2 pt-2.5 text-[11px] text-ink-2">
              {footer}
            </footer>
          )}
        </div>
      )}
    </div>
  )
}
