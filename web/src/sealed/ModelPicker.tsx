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
    return models.filter(model =>
      `${model.name} ${model.id} ${model.provider}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    )
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
      className={`model-picker-control${variant === 'composer' ? ' composer-model-control' : ''}`}
      ref={controlRef}
    >
      <button
        aria-controls={pickerId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${selection?.label ?? placeholder}${selection?.detail ?? ''}，${ariaLabel}`}
        className={
          variant === 'composer'
            ? 'composer-model-button'
            : 'model-picker-trigger'
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
        <span>
          <strong>{selection?.label ?? placeholder}</strong>
          {(selection?.detail ?? placeholderDetail) && (
            <small>{selection?.detail ?? placeholderDetail}</small>
          )}
        </span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div
          aria-labelledby={pickerTitleId}
          className={`composer-model-picker model-picker-panel${
            variant === 'composer' ? ' is-composer' : ''
          }${placement === 'up' ? ' is-up' : ''}`}
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
          <header>
            <div>
              <h2 id={pickerTitleId}>{title}</h2>
              <p>{description}</p>
            </div>
            <span>{models.length} 个可用</span>
          </header>
          <label className="composer-model-search">
            <Search size={16} />
            <span className="visually-hidden">搜索模型</span>
            <input
              autoComplete="off"
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
            className="composer-model-list"
            role="listbox"
          >
            {filteredFixed.map(option => {
              const isSelected = option.value === value
              const isSaving = savingKey === option.value
              return (
                <div
                  aria-disabled={Boolean(savingKey)}
                  aria-selected={isSelected}
                  className="composer-model-option is-fixed"
                  data-value={option.value}
                  key={`fixed:${option.value}`}
                  onClick={() => {
                    if (!savingKey) void selectValue(option.value)
                  }}
                  role="option"
                  tabIndex={isSelected ? 0 : -1}
                >
                  <span>
                    <strong>{option.label}</strong>
                    {option.hint && <small>{option.hint}</small>}
                  </span>
                  {isSaving ? (
                    <RotateCw className="is-spinning" size={17} />
                  ) : (
                    isSelected && <Check size={18} />
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
                      className="composer-model-option"
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
                      <span>
                        <strong>{model.name}</strong>
                        <small>
                          {model.provider}
                          {model.id !== model.name ? ` · ${model.id}` : ''}
                        </small>
                      </span>
                      {isSaving ? (
                        <RotateCw className="is-spinning" size={17} />
                      ) : (
                        isSelected && <Check size={18} />
                      )}
                    </div>
                  )
                })
              : !filteredFixed.length && (
                  <p className="composer-model-empty">没有匹配的模型</p>
                )}
          </div>
          {filteredModels.length > pageSize && (
            <div className="composer-model-pagination pagination">
              <span>
                {currentPage * pageSize + 1}–
                {Math.min((currentPage + 1) * pageSize, filteredModels.length)}{' '}
                / {filteredModels.length}
              </span>
              <button
                disabled={currentPage === 0}
                onClick={() => setPage(Math.max(0, currentPage - 1))}
                type="button"
              >
                上一页
              </button>
              <button
                disabled={currentPage >= pageCount - 1}
                onClick={() =>
                  setPage(Math.min(pageCount - 1, currentPage + 1))
                }
                type="button"
              >
                下一页
              </button>
            </div>
          )}
          {error && (
            <p className="composer-model-error" role="alert">
              {error}
            </p>
          )}
          {footer && <footer>{footer}</footer>}
        </div>
      )}
    </div>
  )
}
