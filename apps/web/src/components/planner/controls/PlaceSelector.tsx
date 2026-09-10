'use client';

import { useMemo, useState } from 'react';

import { Icon } from '@/components/Icon';

import type { ControlProps } from './control-props';

/**
 * 地点选择器(二级页面模式)。
 *
 * 主界面只显示选中的结果(只读卡片+「修改」按钮),点击后弹出二级页面
 * (模态框)进行地点选择或自定义输入。
 *
 * 数据来源是 `cities.json`(Top 2926 城市,81 个国家)。选择国家后,
 * 城市下拉框加载该国的城市列表;选择城市后自动填充 `place_id` / `country`
 * / `lat` / `lng`。自定义输入时 `custom: true`,国家从下拉框选择(结构化)。
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

/** 从 JSON 文件导入城市数据(构建期内联,运行期零网络请求) */
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

/**
 * 地点选择模态框(二级页面)。
 *
 * 主界面点击「选择地点」或「修改」按钮后弹出,包含两种模式:
 * - 选择模式:国家 → 城市 级联下拉
 * - 自定义模式:自由文本输入(地点名 + 国家下拉框)
 */
function PlaceSelectorModal({
  value,
  onChange,
  onClose,
  id,
}: {
  readonly value: PlaceSelectorValue | undefined;
  readonly onChange: (next: PlaceSelectorValue | undefined) => void;
  readonly onClose: () => void;
  readonly id: string;
}): React.ReactElement {
  const [mode, setMode] = useState<'select' | 'custom'>('select');
  const [selectedCountry, setSelectedCountry] = useState(value?.country ?? '');
  const [selectedCity, setSelectedCity] = useState(value?.place_id ?? '');
  const [customText, setCustomText] = useState(value?.text ?? '');
  const [customCountry, setCustomCountry] = useState(value?.country ?? '');

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
    onClose(); // 选择完成,关闭模态框
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
    onClose(); // 提交完成,关闭模态框
  };

  return (
    <div className="planner-overlay planner-overlay--open" onClick={onClose}>
      <div
        className="planner-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <div className="planner-modal__header">
          <h3 id={`${id}-title`} className="planner-modal__title">
            选择地点
          </h3>
          <button
            type="button"
            className="planner-modal__close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="planner-modal__body">
          {mode === 'custom' ? (
            <div className="planner-custom-input">
              <button
                type="button"
                className="planner-button planner-button--secondary planner-button--small"
                onClick={() => setMode('select')}
              >
                ← 从列表选择
              </button>
              <div style={{ marginTop: '16px' }}>
                <label htmlFor={`${id}-custom-text`} className="planner-label">
                  地点名
                </label>
                <input
                  id={`${id}-custom-text`}
                  type="text"
                  className="planner-input"
                  placeholder="输入地点名"
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  maxLength={200}
                />
              </div>
              <div style={{ marginTop: '12px' }}>
                <label htmlFor={`${id}-custom-country`} className="planner-label">
                  国家
                </label>
                <CountrySelect
                  value={customCountry}
                  onChange={setCustomCountry}
                  id={`${id}-custom-country`}
                />
              </div>
              <div style={{ marginTop: '16px' }}>
                <button
                  type="button"
                  className="planner-button planner-button--primary"
                  onClick={handleCustomSubmit}
                  disabled={customText.trim().length === 0 || customCountry.trim().length === 0}
                >
                  确定
                </button>
              </div>
            </div>
          ) : (
            <div className="planner-cascade-select">
              <div>
                <label htmlFor={`${id}-country`} className="planner-label">
                  国家
                </label>
                <CountrySelect
                  value={selectedCountry}
                  onChange={handleCountryChange}
                  id={`${id}-country`}
                />
              </div>
              <div style={{ marginTop: '12px' }}>
                <label htmlFor={`${id}-city`} className="planner-label">
                  城市
                </label>
                <CitySelect
                  countryCode={selectedCountry}
                  value={selectedCity}
                  onChange={handleCityChange}
                  id={`${id}-city`}
                />
              </div>
              <div style={{ marginTop: '16px' }}>
                <button
                  type="button"
                  className="planner-button planner-button--secondary"
                  onClick={() => setMode('custom')}
                >
                  🔍 自定义输入
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 地点选择器(主界面)。
 *
 * 只显示选中的结果(只读卡片),点击「选择地点」或「修改」按钮后弹出
 * 二级页面(模态框)进行选择或自定义输入。
 */
export function PlaceSelector({
  value,
  onChange,
  id,
  describedBy,
}: ControlProps): React.ReactElement {
  const [modalOpen, setModalOpen] = useState(false);

  const currentValue =
    typeof value === 'object' && value !== null
      ? (value as Partial<PlaceSelectorValue>)
      : undefined;

  const displayText = currentValue
    ? `${
        currentValue.country
          ? (citiesData.countries.find((c) => c.code === currentValue.country)?.name ??
            currentValue.country)
          : ''
      }${currentValue.country && currentValue.text ? ' · ' : ''}${currentValue.text ?? ''}`
    : '';

  return (
    <div
      id={id}
      className="planner-place-selector"
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
    >
      {currentValue ? (
        <div className="planner-selected-place">
          <Icon name="map" size={20} className="planner-selected-place__icon" />
          <span className="planner-selected-place__text">{displayText}</span>
          <button
            type="button"
            className="planner-icon-button"
            onClick={() => setModalOpen(true)}
            aria-label="修改地点"
          >
            <Icon name="more-vertical" size={18} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="planner-add-card"
          onClick={() => setModalOpen(true)}
        >
          <span className="planner-add-card__plus" aria-hidden="true">
            ＋
          </span>
          <span>选择地点</span>
        </button>
      )}

      {modalOpen && (
        <PlaceSelectorModal
          value={currentValue && currentValue.text && currentValue.country ? (currentValue as PlaceSelectorValue) : undefined}
          onChange={onChange}
          onClose={() => setModalOpen(false)}
          id={`${id}-modal`}
        />
      )}
    </div>
  );
}
