'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

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

/** 简单的模糊匹配(子序列匹配) */
function fuzzyMatch(text: string, query: string): boolean {
  let i = 0;
  for (const char of text) {
    if (char === query[i]) i++;
    if (i === query.length) return true;
  }
  return false;
}

/** 搜索城市 */
function searchCities(query: string): FlatCity[] {
  if (!query) return [];

  const q = query.toLowerCase();

  // 精确前缀匹配
  const prefixMatches = allCities.filter((city) =>
    city.name.toLowerCase().startsWith(q) ||
    city.localName.toLowerCase().startsWith(q),
  );

  // 包含匹配
  const containsMatches = allCities.filter(
    (city) =>
      !prefixMatches.includes(city) &&
      (city.name.toLowerCase().includes(q) ||
        city.localName.toLowerCase().includes(q) ||
        city.aliases.some((alias) => alias.toLowerCase().includes(q)) ||
        city.iata.some((code) => code.toLowerCase().includes(q))),
  );

  // 模糊匹配
  const fuzzyMatches = allCities.filter(
    (city) =>
      !prefixMatches.includes(city) &&
      !containsMatches.includes(city) &&
      fuzzyMatch(city.searchText, q),
  );

  // 合并并按热门程度排序
  return [...prefixMatches, ...containsMatches, ...fuzzyMatches]
    .sort((a, b) => b.popularity - a.popularity)
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
            >
          {suggestions.length === 0 ? (
            <li className="city-combobox__empty">
              未找到匹配的城市。试试搜索国家名或机场代码。
            </li>
          ) : (
            suggestions.map((city, index) => (
              <li
                key={city.id}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={index === highlightedIndex}
                className={`city-combobox__option${
                  index === highlightedIndex ? ' city-combobox__option--highlighted' : ''
                }`}
                onClick={() => handleSelect(city)}
                onMouseEnter={() => setHighlightedIndex(index)}
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
            ))
          )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
