import { Check, ChevronDown, Search } from "lucide-react";
import {
  Children,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

type SelectValue = string | number;

export interface SelectOption {
  value: SelectValue;
  label: string;
  description?: string;
  disabled?: boolean;
  searchText?: string;
}

export interface SelectOptionGroup {
  label: string;
  options: ReadonlyArray<SelectOption>;
}

export interface SelectChangeEvent {
  target: {
    value: string;
    values: string[];
    name?: string;
  };
  currentTarget: {
    value: string;
    values: string[];
    name?: string;
  };
}

type BaseSelectProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "defaultValue" | "onChange" | "onKeyDown"
> & {
  children?: ReactNode;
  options?: ReadonlyArray<SelectOption | SelectOptionGroup>;
  disabled?: boolean;
  emptyMessage?: string;
  name?: string;
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
};

type SingleSelectProps = BaseSelectProps & {
  multiple?: false;
  value?: SelectValue;
  defaultValue?: SelectValue;
  onChange?: (event: SelectChangeEvent) => void;
  onValueChange?: (value: string) => void;
  onValuesChange?: never;
};

type MultiSelectProps = BaseSelectProps & {
  multiple: true;
  value?: ReadonlyArray<SelectValue>;
  defaultValue?: ReadonlyArray<SelectValue>;
  onChange?: (event: SelectChangeEvent) => void;
  onValueChange?: never;
  onValuesChange?: (values: string[]) => void;
};

export type SelectProps = SingleSelectProps | MultiSelectProps;

interface NormalizedOption {
  value: string;
  label: string;
  description?: string;
  disabled: boolean;
  group?: string;
  searchText: string;
}

interface NormalizedOptionGroup {
  label?: string;
  options: NormalizedOption[];
}

interface ChildOptionProps {
  children?: ReactNode;
  disabled?: boolean;
  label?: string;
  value?: SelectValue;
  "data-description"?: string;
}

interface ChildOptionGroupProps {
  children?: ReactNode;
  label?: string;
}

export const SELECT_CLASS =
  "flex h-7 w-full items-center rounded-md border border-border bg-bg font-mono text-xs text-fg outline-none transition focus-visible:border-accent";

const SELECT_ROOT_CLASS = "relative inline-block min-w-0 text-xs";

export const Select = forwardRef<HTMLButtonElement, SelectProps>(
  function Select(props, ref) {
    const {
      children,
      className,
      disabled = false,
      emptyMessage = "No options",
      name,
      options,
      placeholder = "",
      searchable = false,
      searchPlaceholder = "Search options",
      onChange,
      value: _value,
      defaultValue: _defaultValue,
      multiple: _multiple,
      onValueChange: _onValueChange,
      onValuesChange: _onValuesChange,
      ...rest
    } = props;
    const rootRef = useRef<HTMLDivElement | null>(null);
    const listboxRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const reactId = useId();
    const listboxId = `${reactId}-listbox`;
    const multiple = props.multiple === true;
    const optionGroups = useMemo(
      () => normalizeOptionGroups(options, children),
      [children, options],
    );
    const allOptions = useMemo(
      () => optionGroups.flatMap((group) => group.options),
      [optionGroups],
    );
    const [internalValues, setInternalValues] = useState<string[]>(() => {
      if (props.multiple) {
        return normalizeValues(props.defaultValue ?? []);
      }
      return normalizeValue(props.defaultValue);
    });
    const controlledValues = useMemo(() => {
      if (props.value === undefined) return null;
      return props.multiple
        ? normalizeValues(props.value)
        : normalizeValue(props.value);
    }, [props.multiple, props.value]);
    const selectedValues = controlledValues ?? internalValues;
    const selectedSet = useMemo(
      () => new Set(selectedValues),
      [selectedValues],
    );
    const selectedLabels = useMemo(() => {
      const byValue = new Map(allOptions.map((option) => [option.value, option]));
      return selectedValues.map((value) => byValue.get(value)?.label ?? value);
    }, [allOptions, selectedValues]);
    const [isOpen, setIsOpen] = useState(false);
    const [listboxRect, setListboxRect] = useState<{
      left: number;
      top: number;
      width: number;
    } | null>(null);
    const [query, setQuery] = useState("");
    const [activeIndex, setActiveIndex] = useState(-1);
    const visibleGroups = useMemo(
      () => filterGroups(optionGroups, searchable ? query : ""),
      [optionGroups, query, searchable],
    );
    const visibleOptions = useMemo(
      () => visibleGroups.flatMap((group) => group.options),
      [visibleGroups],
    );
    const displayValue = selectedLabels.join(", ");
    const hasDisplayValue = displayValue.length > 0;
    const activeOption =
      activeIndex >= 0 ? visibleOptions[activeIndex] : undefined;
    const activeOptionId = activeOption
      ? optionId(listboxId, activeIndex)
      : undefined;

    const openList = () => {
      if (disabled) return;
      setQuery("");
      setIsOpen(true);
    };

    const closeList = () => {
      setIsOpen(false);
      setListboxRect(null);
      setQuery("");
      setActiveIndex(-1);
    };

    useEffect(() => {
      if (!isOpen) return;
      setActiveIndex((current) => {
        if (
          current >= 0 &&
          current < visibleOptions.length &&
          !visibleOptions[current]?.disabled
        ) {
          return current;
        }

        const selectedIndex = visibleOptions.findIndex(
          (option) => selectedSet.has(option.value) && !option.disabled,
        );
        if (selectedIndex >= 0) return selectedIndex;

        return firstEnabledIndex(visibleOptions);
      });
    }, [isOpen, selectedSet, visibleOptions]);

    useEffect(() => {
      if (!isOpen) return;

      const handlePointerDown = (event: PointerEvent) => {
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (rootRef.current?.contains(target)) return;
        if (listboxRef.current?.contains(target)) return;
        closeList();
      };

      document.addEventListener("pointerdown", handlePointerDown);
      return () => {
        document.removeEventListener("pointerdown", handlePointerDown);
      };
    }, [isOpen]);

    useLayoutEffect(() => {
      if (!isOpen) return;

      const updateListboxRect = () => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return;
        setListboxRect({
          left: rect.left,
          top: rect.bottom + 4,
          width: rect.width,
        });
      };

      updateListboxRect();
      window.addEventListener("resize", updateListboxRect);
      window.addEventListener("scroll", updateListboxRect, true);
      return () => {
        window.removeEventListener("resize", updateListboxRect);
        window.removeEventListener("scroll", updateListboxRect, true);
      };
    }, [isOpen]);

    useLayoutEffect(() => {
      if (!isOpen || !searchable || !listboxRect) return;
      searchInputRef.current?.focus();
    }, [isOpen, listboxRect, searchable]);

    const assignTriggerRef = (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    };

    const commitValues = (nextValues: string[]) => {
      if (props.value === undefined) {
        setInternalValues(nextValues);
      }

      if (props.multiple) {
        props.onValuesChange?.(nextValues);
      } else {
        props.onValueChange?.(nextValues[0] ?? "");
      }

      const target = {
        value: nextValues[0] ?? "",
        values: nextValues,
        name,
      };
      onChange?.({ target, currentTarget: target });
    };

    const selectOption = (option: NormalizedOption) => {
      if (option.disabled) return;
      if (props.multiple) {
        const nextValues = selectedSet.has(option.value)
          ? selectedValues.filter((value) => value !== option.value)
          : [...selectedValues, option.value];
        commitValues(nextValues);
        setQuery("");
        setIsOpen(true);
      } else {
        commitValues([option.value]);
        closeList();
        triggerRef.current?.focus();
      }
    };

    const moveActive = (delta: 1 | -1) => {
      const enabledIndexes = visibleOptions
        .map((option, index) => (option.disabled ? -1 : index))
        .filter((index) => index >= 0);
      if (enabledIndexes.length === 0) {
        setActiveIndex(-1);
        return;
      }

      setActiveIndex((current) => {
        const currentPosition = enabledIndexes.indexOf(current);
        if (currentPosition === -1) {
          return delta > 0
            ? enabledIndexes[0]
            : enabledIndexes[enabledIndexes.length - 1];
        }
        const nextPosition =
          (currentPosition + delta + enabledIndexes.length) %
          enabledIndexes.length;
        return enabledIndexes[nextPosition];
      });
    };

    const chooseActiveOption = () => {
      const option =
        visibleOptions[activeIndex] ??
        visibleOptions.find((candidate) => !candidate.disabled);
      if (option && !option.disabled) {
        selectOption(option);
        return true;
      }
      return false;
    };

    const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          event.stopPropagation();
          openList();
          moveActive(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          event.stopPropagation();
          openList();
          moveActive(-1);
          break;
        case "Enter":
          if (!isOpen) {
            event.preventDefault();
            event.stopPropagation();
            openList();
            break;
          }
          if (chooseActiveOption()) {
            event.preventDefault();
            event.stopPropagation();
          }
          break;
        case " ":
          if (!isOpen) {
            event.preventDefault();
            event.stopPropagation();
            openList();
          }
          break;
        case "Escape":
          if (isOpen) {
            event.preventDefault();
            event.stopPropagation();
            closeList();
          }
          break;
        case "Tab":
          closeList();
          break;
      }
    };

    const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          event.stopPropagation();
          moveActive(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          event.stopPropagation();
          moveActive(-1);
          break;
        case "Enter":
          if (chooseActiveOption()) {
            event.preventDefault();
            event.stopPropagation();
          }
          break;
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          closeList();
          triggerRef.current?.focus();
          break;
        case "Tab":
          closeList();
          break;
      }
    };

    const handleTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (disabled) return;
      if (isOpen) {
        closeList();
      } else {
        openList();
      }
    };

    const listbox =
      isOpen && listboxRect
        ? createPortal(
            <div
              ref={listboxRef}
              className="fixed z-[60] overflow-hidden rounded-md border border-border bg-bg-elevated font-mono text-xs text-fg shadow-xl"
              style={{
                left: listboxRect.left,
                minWidth: listboxRect.width,
                top: listboxRect.top,
              }}
            >
              {searchable ? (
                <div className="border-b border-border p-1.5">
                  <div className="flex h-7 items-center rounded-md border border-border bg-bg px-2 focus-within:border-accent">
                    <Search
                      aria-hidden="true"
                      size={13}
                      className="mr-1.5 shrink-0 text-fg-muted"
                    />
                    <input
                      ref={searchInputRef}
                      data-select-search
                      aria-activedescendant={activeOptionId}
                      aria-controls={listboxId}
                      aria-label={searchPlaceholder}
                      autoComplete="off"
                      className="h-full min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-muted"
                      placeholder={searchPlaceholder}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={handleSearchKeyDown}
                    />
                  </div>
                </div>
              ) : null}
              <div
                id={listboxId}
                role="listbox"
                aria-multiselectable={multiple || undefined}
                className="max-h-56 overflow-y-auto py-1"
              >
                {visibleGroups.length > 0 ? (
                  visibleGroups.map((group, groupIndex) => (
                    <div key={`${group.label ?? "group"}-${groupIndex}`}>
                      {group.label ? (
                        <div
                          data-select-group-label
                          className="px-2 py-1 text-[10px] font-semibold uppercase tracking-normal text-fg-muted"
                        >
                          {group.label}
                        </div>
                      ) : null}
                      {group.options.map((option) => {
                        const optionIndex = visibleOptions.indexOf(option);
                        const selected = selectedSet.has(option.value);
                        const active = optionIndex === activeIndex;
                        return (
                          <div
                            id={optionId(listboxId, optionIndex)}
                            key={`${option.group ?? "option"}-${option.value}`}
                            role="option"
                            aria-disabled={option.disabled || undefined}
                            aria-selected={selected}
                            className={cn(
                              "flex min-h-7 cursor-default items-center gap-2 px-2 py-1.5",
                              option.disabled && "opacity-50",
                              active && "bg-accent/15 text-fg",
                              !active && "text-fg",
                            )}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseEnter={() => {
                              if (!option.disabled) setActiveIndex(optionIndex);
                            }}
                            onClick={() => selectOption(option)}
                          >
                            <span className="min-w-0 flex-1">
                              <span
                                data-select-option-label
                                className="block truncate"
                              >
                                {option.label}
                              </span>
                              {option.description ? (
                                <span
                                  data-select-option-description
                                  className="block truncate text-[11px] text-fg-muted"
                                >
                                  {option.description}
                                </span>
                              ) : null}
                            </span>
                            {selected ? (
                              <Check
                                aria-hidden="true"
                                size={13}
                                className="shrink-0 text-accent"
                              />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ))
                ) : (
                  <div className="px-2 py-2 text-fg-muted">{emptyMessage}</div>
                )}
              </div>
            </div>,
            document.body,
          )
        : null;

    return (
      <div ref={rootRef} {...rest} className={cn(SELECT_ROOT_CLASS, className)}>
        {name
          ? selectedValues.map((value) => (
              <input key={value} type="hidden" name={name} value={value} />
            ))
          : null}
        <button
          ref={assignTriggerRef}
          type="button"
          role="combobox"
          aria-activedescendant={!searchable ? activeOptionId : undefined}
          aria-autocomplete={searchable ? "list" : "none"}
          aria-controls={isOpen ? listboxId : undefined}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label={props["aria-label"]}
          aria-labelledby={props["aria-labelledby"]}
          aria-describedby={props["aria-describedby"]}
          disabled={disabled}
          className={cn(
            SELECT_CLASS,
            "justify-between text-left",
            disabled && "cursor-not-allowed opacity-60",
            isOpen && "border-accent",
          )}
          onClick={handleTriggerClick}
          onKeyDown={handleTriggerKeyDown}
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate px-2",
              !hasDisplayValue && "text-fg-muted",
            )}
          >
            {hasDisplayValue ? displayValue : placeholder}
          </span>
          <ChevronDown
            aria-hidden="true"
            size={14}
            className={cn(
              "mr-1.5 shrink-0 text-fg-muted transition",
              isOpen && "rotate-180 text-fg",
            )}
          />
        </button>

        {listbox}
      </div>
    );
  },
);

function normalizeValue(value: SelectValue | undefined): string[] {
  return value === undefined ? [] : [String(value)];
}

function normalizeValues(values: ReadonlyArray<SelectValue>): string[] {
  return values.map((value) => String(value));
}

function normalizeOptionGroups(
  options: ReadonlyArray<SelectOption | SelectOptionGroup> | undefined,
  children: ReactNode,
): NormalizedOptionGroup[] {
  if (options) {
    return normalizeExplicitOptions(options);
  }

  const groups: NormalizedOptionGroup[] = [];
  const ungrouped: NormalizedOption[] = [];

  Children.forEach(children, (child) => {
    if (!isValidElement(child) || typeof child.type !== "string") return;

    if (child.type === "option") {
      ungrouped.push(normalizeChildOption(child.props as ChildOptionProps));
      return;
    }

    if (child.type === "optgroup") {
      const optgroupProps = child.props as ChildOptionGroupProps;
      const label =
        typeof optgroupProps.label === "string"
          ? optgroupProps.label
          : undefined;
      const groupOptions: NormalizedOption[] = [];
      Children.forEach(optgroupProps.children, (optionChild) => {
        if (
          isValidElement(optionChild) &&
          typeof optionChild.type === "string" &&
          optionChild.type === "option"
        ) {
          groupOptions.push(
            normalizeChildOption(optionChild.props as ChildOptionProps, label),
          );
        }
      });
      groups.push({ label, options: groupOptions });
    }
  });

  if (ungrouped.length > 0) {
    groups.unshift({ options: ungrouped });
  }

  return groups;
}

function normalizeExplicitOptions(
  options: ReadonlyArray<SelectOption | SelectOptionGroup>,
): NormalizedOptionGroup[] {
  const groups: NormalizedOptionGroup[] = [];
  const ungrouped: NormalizedOption[] = [];

  for (const item of options) {
    if ("options" in item) {
      groups.push({
        label: item.label,
        options: item.options.map((option) =>
          normalizeOption(option, item.label),
        ),
      });
    } else {
      ungrouped.push(normalizeOption(item));
    }
  }

  if (ungrouped.length > 0) {
    groups.unshift({ options: ungrouped });
  }

  return groups;
}

function normalizeChildOption(
  props: ChildOptionProps,
  group?: string,
): NormalizedOption {
  const label = props.label ?? textFromReactNode(props.children);
  return normalizeOption(
    {
      value: props.value ?? label,
      label,
      description: props["data-description"],
      disabled: props.disabled,
    },
    group,
  );
}

function normalizeOption(
  option: SelectOption,
  group?: string,
): NormalizedOption {
  const value = String(option.value);
  const label = option.label;
  const description = option.description;
  return {
    value,
    label,
    description,
    disabled: option.disabled === true,
    group,
    searchText: [label, description, value, group, option.searchText]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  };
}

function filterGroups(
  groups: NormalizedOptionGroup[],
  query: string,
): NormalizedOptionGroup[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return groups;

  return groups
    .map((group) => ({
      ...group,
      options: group.options.filter((option) =>
        option.searchText.includes(normalizedQuery),
      ),
    }))
    .filter((group) => group.options.length > 0);
}

function firstEnabledIndex(options: ReadonlyArray<NormalizedOption>): number {
  return options.findIndex((option) => !option.disabled);
}

function optionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

function textFromReactNode(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      return "";
    })
    .join("")
    .trim();
}
