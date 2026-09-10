'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import Fuse from 'fuse.js';

import { Icon } from '@/components/Icon';

/**
 * 可搜索的城市选择器(Combobox)。
 *
 * 遵循 W3C ARIA Combobox 模式:
 * - 输入框: role="combobox", aria-expanded, aria-controls, aria-activedescendant
 * - 列表: role="listbox", 选项 role="option" + aria-selected
 * - 键盘导航: ↓↑ 移动高亮, Enter 选中, Esc 关闭, Home/End 跳首尾
 *
 * 数据来源是 `cities.json`(2926 城市, 81 个国家)。
 * 支持拼音/原文/本地语言/别名/机场代码搜索, 容错匹配, 按热门程度排序。
 */

interface City {
  readonly id: string;
  readonly name: string;
  readonly localName: string;
  readonly aliases: readonly string[];
  readonly iata: readonly string[];
  readonly popularity: number;
  readonly lat: number;
  readonly lng: number;
  readonly searchText: string;
}

interface Country {
  readonly code: string;
  readonly name: string;
  readonly cities: readonly City[];
}

interface CitiesData {
  readonly version: string;
  readonly updated_at: string;
  readonly countries: readonly Country[];
}

import citiesDataJson from '@/data/cities.json';

const citiesData = citiesDataJson as CitiesData;

export interface CityComboboxValue {
  readonly id: string;
  readonly name: string;
  readonly country: string;
  readonly countryCode: string;
  readonly lat: number;
  readonly lng: number;
}

export interface CityComboboxProps {
  readonly value: CityComboboxValue | undefined;
  readonly onChange: (city: CityComboboxValue | undefined) => void;
  readonly placeholder?: string;
  readonly id: string;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
}

/** 拍平所有城市,附加国家信息 */
interface FlatCity extends City {
  readonly country: string;
  readonly countryCode: string;
}

const allCities: FlatCity[] = citiesData.countries.flatMap((country) =>
  country.cities.map((city) => ({
    ...city,
    country: country.name,
    countryCode: country.code,
  })),
);

/** 热门城市(popularity >= 85,按热度降序) */
const popularCities = allCities
  .filter((city) => city.popularity >= 85)
  .sort((a, b) => b.popularity - a.popularity)
  .slice(0, 12);

/** 搜索城市(用 Fuse.js 做模糊匹配) */
const fuse = new Fuse(allCities, {
  keys: ['name', 'localName', 'aliases', 'iata', 'searchText'],
  threshold: 0.3, // 模糊匹配阈值(0 = 精确匹配, 1 = 完全模糊)
  includeScore: true,
  minMatchCharLength: 1,
});

function searchCities(query: string): FlatCity[] {
  if (!query) return [];

  const results = fuse.search(query);
  return results
    .map((result) => result.item)
    .sort((a, b) => {
      // 优先按 Fuse.js 的 score 排序(score 越小越好)
      const scoreA = results.find((r) => r.item === a)?.score ?? 1;
      const scoreB = results.find((r) => r.item === b)?.score ?? 1;
      if (scoreA !== scoreB) return scoreA - scoreB;
      // 同分按热门程度排序
      return b.popularity - a.popularity;
    })
    .slice(0, 50);
}

export function CityCombobox({
  value,
  onChange,
  placeholder = '搜索城市',
  id,
  disabled = false,
  ariaLabel = '选择城市',
}: CityComboboxProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // 搜索结果
  const results = useMemo(() => searchCities(query), [query]);

  // 默认推荐(热门城市)
  const suggestions = useMemo(() => (query ? results : popularCities), [query, results]);

  // 虚拟滚动
  const virtualizer = useVirtualizer({
    count: suggestions.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 56,
    overscan: 5,
  });

  // 键盘导航
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (disabled) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          setHighlightedIndex((i) => Math.min(i + 1, suggestions.length - 1));
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (open && suggestions[highlightedIndex]) {
          handleSelect(suggestions[highlightedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        setQuery('');
        break;
      case 'Home':
        if (open) {
          e.preventDefault();
          setHighlightedIndex(0);
        }
        break;
      case 'End':
        if (open) {
          e.preventDefault();
          setHighlightedIndex(suggestions.length - 1);
        }
        break;
    }
  };

  const handleSelect = (city: FlatCity): void => {
    onChange({
      id: city.id,
      name: city.name,
      country: city.country,
      countryCode: city.countryCode,
      lat: city.lat,
      lng: city.lng,
    });
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  const handleClear = (): void => {
    onChange(undefined);
    setQuery('');
    inputRef.current?.focus();
  };

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (
        inputRef.current &&
        !inputRef.current.contains(e.target as Node) &&
        listRef.current &&
        !listRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };

    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
    return undefined;
  }, [open]);

  // 高亮项滚动到可视区域
  useEffect(() => {
    if (open && listRef.current) {
      const highlighted = listRef.current.children[highlightedIndex] as HTMLElement;
      if (highlighted) {
        highlighted.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [highlightedIndex, open]);

  return (
    <div className="city-combobox">
      <div className="city-combobox__input-wrapper">
        <Icon name="map-pin" size={18} className="city-combobox__icon" />
        <input
          ref={inputRef}
          type="text"
          id={id}
          className="city-combobox__input"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          aria-activedescendant={
            open && suggestions[highlightedIndex] ? `${id}-option-${highlightedIndex}` : undefined
          }
          aria-label={ariaLabel}
          placeholder={value ? `${value.country} · ${value.name}` : placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlightedIndex(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
        />
        {value && (
          <button
            type="button"
            className="city-combobox__clear"
            onClick={handleClear}
            aria-label="清除选择"
          >
            ✕
          </button>
        )}
      </div>

      {open && (
        <div className="city-combobox__overlay" onClick={() => setOpen(false)}>
          <div
            className="city-combobox__modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="选择城市"
          >
            <div className="city-combobox__modal-header">
              <input
                type="text"
                className="city-combobox__input city-combobox__input--modal"
                placeholder="搜索城市(支持拼音/英文/机场代码)"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlightedIndex(0);
                }}
                onKeyDown={handleKeyDown}
                autoFocus
              />
              <button
                type="button"
                className="city-combobox__modal-close"
                onClick={() => setOpen(false)}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <ul
              ref={listRef}
              id={`${id}-listbox`}
              className="city-combobox__listbox"
              role="listbox"
              aria-label="城市列表"
              style={{
                height: '320px',
                overflow: 'auto',
                position: 'relative',
              }}
            >
          {suggestions.length === 0 ? (
            <li className="city-combobox__empty">
              未找到匹配的城市。试试搜索国家名或机场代码。
            </li>
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const city = suggestions[virtualItem.index];
                if (!city) return null;
                return (
                  <li
                    key={city.id}
                    id={`${id}-option-${virtualItem.index}`}
                    role="option"
                    aria-selected={virtualItem.index === highlightedIndex}
                    className={`city-combobox__option${
                      virtualItem.index === highlightedIndex ? ' city-combobox__option--highlighted' : ''
                    }`}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualItem.size}px`,
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                    onClick={() => handleSelect(city)}
                    onMouseEnter={() => setHighlightedIndex(virtualItem.index)}
                  >
                    <div className="city-combobox__option-name">
                      <strong>{city.name}</strong>
                      {city.localName !== city.name && (
                        <span className="city-combobox__option-local"> · {city.localName}</span>
                      )}
                    </div>
                    <div className="city-combobox__option-meta">
                      {city.country} · {city.countryCode}
                    </div>
                  </li>
                );
              })}
            </div>
          )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
