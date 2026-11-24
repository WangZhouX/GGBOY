import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { isActivityPublicKey, isActivitySignature } from '../../features/activity/activityIdentifiers';

/** URL 与搜索表单共用的三个精确查询条件。 Exact-match fields shared by the URL and search form. */
export interface ActivitySearchFilters {
  /** 匹配参与方的 32 字节 Base58 钱包地址。 Participant's 32-byte Base58 wallet address. */
  wallet: string;
  /** 金库或市场状态账户的 32 字节 Base58 公钥。 The vault or market's 32-byte Base58 state address. */
  subjectAddress: string;
  /** 完整的 64 字节 Base58 交易签名。 Complete 64-byte Base58 transaction signature. */
  signature: string;
}

/** 列表使用同一字段集合读取 URL、验证和清空筛选。 Use the same fields for reading, validating, and clearing filters. */
export const activitySearchKeys = ['wallet', 'subjectAddress', 'signature'] as const;

/** 搜索字段与可定位的校验提示共用同一个联合类型。 Identifies a search field and its validation message. */
type SearchKey = (typeof activitySearchKeys)[number];

/** 页面提供已应用的查询和写入路由的交互。 The page supplies applied filters and a callback for writing them to the route. */
interface ActivityFiltersFormProps {
  /** 已从当前 URL 读取的筛选条件。 Filters read from the current URL. */
  filters: ActivitySearchFilters;
  /** 应用或清除筛选后由页面更新 URL。 Update the route after applying or clearing filters. */
  applyFilters(filters: ActivitySearchFilters): void;
}

/**
 * 查找第一个格式不符合链上长度的查询字段。
 * Find the first query field whose encoding does not match its Solana byte length.
 *
 * @param filters 已去除空格的查询参数。 Trimmed search parameters.
 */
export function invalidActivitySearchField(filters: ActivitySearchFilters): SearchKey | undefined {
  return activitySearchKeys.find((key) => filters[key] !== '' &&
    !(key === 'signature' ? isActivitySignature : isActivityPublicKey)(filters[key]));
}

/**
 * 编辑并提交精确匹配条件。输入中间状态只存在于表单中。
 * Edit and apply exact-match filters. In-progress input remains in the form.
 *
 * @param props URL 中的查询和提交回调。 URL filters and their submit callback.
 */
export function ActivityFiltersForm({ filters, applyFilters }: ActivityFiltersFormProps) {
  /** 表单文案跟随页面语言。 Translate the form in the current page language. */
  const { t } = useTranslation();
  /** 显式提交或直接打开分享链接时，把错误关联到对应输入。 Associate errors with the input after submission or direct URL access. */
  const [invalidField, setInvalidField] = useState(() => invalidActivitySearchField(filters));

  /**
   * 校验当前输入后提交，避免连续打字触发请求。
   * Validate the current input and apply filters without querying on every keystroke.
   *
   * @param event 搜索表单的提交事件。 Search form's submit event.
   */
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    /** 从当前表单读用户输入。 Read current field values from the submitted form. */
    const form = event.currentTarget;
    const fields = new FormData(form);
    /** 空值表示省略对应查询参数。 Empty text means omitting the corresponding query parameter. */
    const values: ActivitySearchFilters = {
      wallet: String(fields.get('wallet') ?? '').trim(),
      subjectAddress: String(fields.get('subjectAddress') ?? '').trim(),
      signature: String(fields.get('signature') ?? '').trim(),
    };
    /** 错误字段仅用于表单反馈，有效输入才写入路由。 Validation only updates form feedback; valid values are written to the route. */
    const invalid = invalidActivitySearchField(values);
    setInvalidField(invalid);
    if (invalid) {
      /** 输入根据 name 定位，错误后将焦点还给用户。 Find the field by name and restore focus after a validation error. */
      const input = form.elements.namedItem(invalid);
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    applyFilters(values);
  }

  return (
    <form className="activity-search" aria-label={t('activity.searchLabel')} onSubmit={handleSubmit}>
      <div className="activity-search__fields">
        {activitySearchKeys.map((key) => (
          <label className="activity-search__field" key={key}>
            <span>{t('activity.search.' + key)}</span>
            <input
              type="text"
              name={key}
              defaultValue={filters[key]}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={key === 'signature' ? 88 : 44}
              aria-invalid={invalidField === key}
              aria-describedby={invalidField === key ? 'activity-filter-error' : undefined}
              onChange={() => { if (invalidField === key) setInvalidField(undefined); }}
            />
          </label>
        ))}
      </div>
      {invalidField && (
        <p className="activity-feedback activity-feedback--error" id="activity-filter-error" role="alert">
          {t('activity.searchError.' + invalidField)}
        </p>
      )}
      <div className="activity-search__actions">
        <button className="activity-button activity-button--primary" type="submit">{t('activity.searchSubmit')}</button>
        <button
          className="activity-button"
          type="button"
          onClick={(event) => {
            // 也清除尚未提交的输入，即使 URL 中没有任何筛选。
            // Clear draft input even when the URL has no applied filters.
            event.currentTarget.form?.reset();
            setInvalidField(undefined);
            applyFilters({ wallet: '', subjectAddress: '', signature: '' });
          }}
        >
          {t('activity.clearSearch')}
        </button>
      </div>
    </form>
  );
}
