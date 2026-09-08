'use client';

import { useMemo, useState } from 'react';

import { Icon } from '@/components/Icon';

import type { ControlProps } from './control-props';

/**
 * 国家选择器 + 城市选择器（级联下拉）。
 *
 * 数据来源是 `cities.json`（Top 354 城市，51 个国家）。选择国家后，
 * 城市下拉框加载该国的城市列表；选择城市后自动填充 `place_id` / `country`
 * / `lat` / `lng`。自定义输入时 `custom: true`，国家从下拉框选择（结构化）。
 */

interface City {
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
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

/** 从 JSON 文件导入城市数据（构建期内联，运行期零网络请求） */
import citiesDataJson from '@/data/cities.json';

const citiesData = citiesDataJson as CitiesData;

export interface PlaceSelectorValue {
  readonly text: string;
  readonly place_id?: string;
  readonly city?: string;
  readonly country: string;
  readonly custom?: boolean;
  readonly lat?: number;
  readonly lng?: number;
}

export function CountrySelect({
  value,
  onChange,
  id,
  disabled,
}: {
  readonly value: string;
  readonly onChange: (countryCode: string) => void;
  readonly id: string;
  readonly disabled?: boolean;
}): React.ReactElement {
  return (
    <select
      id={id}
      className="planner-input planner-input--select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label="选择国家"
    >
      <option value="">请选择国家</option>
      {citiesData.countries.map((country) => (
        <option key={country.code} value={country.code}>
          {country.name}
        </option>
      ))}
    </select>
  );
}

export function CitySelect({
  countryCode,
  value,
  onChange,
  id,
  disabled,
}: {
  readonly countryCode: string;
  readonly value: string;
  readonly onChange: (city: City) => void;
  readonly id: string;
  readonly disabled?: boolean;
}): React.ReactElement {
  const country = useMemo(
    () => citiesData.countries.find((c) => c.code === countryCode),
    [countryCode],
  );
  const cities = useMemo(() => country?.cities ?? [], [country]);

  return (
    <select
      id={id}
      className="planner-input planner-input--select"
      value={value}
      onChange={(e) => {
        const city = cities.find((c) => c.id === e.target.value);
        if (city) onChange(city);
      }}
      disabled={disabled || cities.length === 0}
      aria-label="选择城市"
    >
      <option value="">请选择城市</option>
      {cities.map((city) => (
        <option key={city.id} value={city.id}>
          {city.name}
        </option>
      ))}
    </select>
  );
}

export function PlaceSelector({
  value,
  onChange,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  const [mode, setMode] = useState<'select' | 'custom'>('select');
  const initialValue =
    typeof value === 'object' && value !== null
      ? (value as Partial<PlaceSelectorValue>)
      : undefined;
  const [selectedCountry, setSelectedCountry] = useState(initialValue?.country ?? '');
  const [selectedCity, setSelectedCity] = useState(initialValue?.place_id ?? '');
  const [customText, setCustomText] = useState(initialValue?.text ?? '');
  const [customCountry, setCustomCountry] = useState(initialValue?.country ?? '');

  const handleCountryChange = (countryCode: string): void => {
    setSelectedCountry(countryCode);
    setSelectedCity(''); // 重置城市选择
  };

  const handleCityChange = (city: City): void => {
    const country = citiesData.countries.find((c) => c.code === selectedCountry);
    if (!country) return;

    onChange({
      text: city.name,
      place_id: city.id,
      city: city.name,
      country: country.code,
      custom: false,
      lat: city.lat,
      lng: city.lng,
    });
    setSelectedCity(city.id);
  };

  const handleCustomSubmit = (): void => {
    if (customText.trim().length === 0 || customCountry.trim().length === 0) {
      return; // 两者都必填
    }
    onChange({
      text: customText.trim(),
      country: customCountry,
      custom: true,
    });
  };

  if (mode === 'custom') {
    return (
      <div
        id={id}
        className="planner-place-selector planner-place-selector--custom"
        {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
      >
        <button
          type="button"
          className="planner-button planner-button--secondary planner-button--small"
          onClick={() => setMode('select')}
        >
          ← 从列表选择
        </button>
        <div className="planner-custom-input">
          <input
            type="text"
            className="planner-input"
            placeholder="地点名"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            maxLength={200}
            aria-label="自定义地点名"
          />
          <CountrySelect
            value={customCountry}
            onChange={setCustomCountry}
            id={`${id}-custom-country`}
          />
          <button
            type="button"
            className="planner-button planner-button--primary planner-button--small"
            onClick={handleCustomSubmit}
            disabled={customText.trim().length === 0 || customCountry.trim().length === 0}
          >
            确定
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      id={id}
      className="planner-place-selector"
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
    >
      <div className="planner-cascade-select">
        <CountrySelect
          value={selectedCountry}
          onChange={handleCountryChange}
          id={`${id}-country`}
        />
        <CitySelect
          countryCode={selectedCountry}
          value={selectedCity}
          onChange={handleCityChange}
          id={`${id}-city`}
        />
        <button
          type="button"
          className="planner-button planner-button--secondary planner-button--small"
          onClick={() => setMode('custom')}
        >
          🔍 自定义
        </button>
      </div>
      {value !== null && typeof value === 'object' && 'text' in value && 'country' in value ? (
        <div className="planner-selected-place">
          <Icon name="map" size={20} className="planner-selected-place__icon" />
          <span className="planner-selected-place__text">
            {typeof (value as PlaceSelectorValue).country === 'string'
              ? citiesData.countries.find(
                  (c) => c.code === (value as PlaceSelectorValue).country,
                )?.name
              : ''}{' '}
            · {(value as PlaceSelectorValue).text}
          </span>
          <button
            type="button"
            className="planner-icon-button"
            onClick={() => onChange(undefined)}
            aria-label="清除选择"
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}
