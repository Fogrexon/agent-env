import { useRef, useState } from 'react';
import type { ParamField } from '@agent-env/shared';
import { isFileLikeParamType, isMultiFileParamType } from '@agent-env/shared';
import { MarkdownEditor } from './MarkdownEditor';

export interface ParamFormProps {
  fields: ParamField[];
  values: Record<string, unknown>;
  onChange: (id: string, value: unknown) => void;
  disabled?: boolean;
}

function filesToText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join('\n');
  if (typeof value === 'string') return value;
  return '';
}

function valueToPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function acceptAttr(field: ParamField): string | undefined {
  if (!('accept' in field) || !field.accept?.length) {
    if (field.type === 'image' || field.type === 'images') {
      return 'image/*';
    }
    return undefined;
  }
  return field.accept.join(',');
}

async function uploadFiles(fileList: FileList): Promise<string[]> {
  const body = new FormData();
  for (const file of Array.from(fileList)) {
    body.append('files', file, file.name);
  }
  const res = await fetch('/api/uploads', { method: 'POST', body });
  const data = (await res.json()) as {
    error?: string;
    files?: Array<{ path: string }>;
  };
  if (!res.ok || !data.files?.length) {
    throw new Error(data.error ?? `Upload failed (${res.status})`);
  }
  return data.files.map((f) => f.path);
}

function FileFieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ParamField;
  value: unknown;
  disabled?: boolean;
  onChange: (id: string, value: unknown) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const multi = isMultiFileParamType(field.type);
  const delivery =
    'delivery' in field && field.delivery
      ? field.delivery
      : field.type === 'image' || field.type === 'images'
        ? 'content'
        : 'path';

  const onPick = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const paths = await uploadFiles(list);
      if (multi) {
        const prev = Array.isArray(value)
          ? value.map(String)
          : filesToText(value)
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean);
        onChange(field.id, [...prev, ...paths]);
      } else {
        onChange(field.id, paths[0] ?? '');
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const textValue = multi ? filesToText(value) : String(value ?? '');
  const previewPath =
    !multi && typeof value === 'string' && value.trim() ? value.trim() : null;
  const isImagePreview =
    previewPath &&
    (field.type === 'image' || IMAGE_PATH_RE.test(previewPath));
  const nonImagePaths = valueToPaths(value).filter(
    (p) => field.type !== 'image' && !IMAGE_PATH_RE.test(p),
  );

  const hintParts = [field.description, `delivery: ${delivery}`];
  if (delivery === 'content') {
    hintParts.push('provider 非対応 MIME はテキスト抽出して送信');
  }

  return (
    <div className="field file-field">
      <label htmlFor={field.id}>
        {field.label}
        {field.required ? ' *' : ''}
      </label>
      <div className="hint">{hintParts.filter(Boolean).join(' · ')}</div>
      <div className="file-row">
        {multi ? (
          <textarea
            id={field.id}
            disabled={disabled || uploading}
            placeholder={
              field.placeholder ??
              'パスを手入力（1行1パス）するか、参照で選択'
            }
            value={textValue}
            onChange={(e) =>
              onChange(
                field.id,
                e.target.value
                  .split(/\r?\n/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          />
        ) : (
          <input
            id={field.id}
            type="text"
            disabled={disabled || uploading}
            placeholder={
              field.placeholder ?? 'パスを手入力するか、参照で選択'
            }
            value={textValue}
            onChange={(e) => onChange(field.id, e.target.value)}
          />
        )}
        <button
          type="button"
          className="secondary"
          disabled={disabled || uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? 'アップロード中…' : '参照…'}
        </button>
        <input
          ref={inputRef}
          type="file"
          className="file-hidden"
          disabled={disabled || uploading}
          accept={acceptAttr(field)}
          multiple={multi}
          onChange={(e) => void onPick(e.target.files)}
        />
      </div>
      {uploadError ? <div className="error">{uploadError}</div> : null}
      {isImagePreview ? (
        <img
          className="file-preview"
          src={`/api/uploads/preview?path=${encodeURIComponent(previewPath)}`}
          alt={previewPath}
        />
      ) : null}
      {nonImagePaths.length > 0 ? (
        <div className="file-chips">
          {nonImagePaths.map((p) => (
            <span className="file-chip" key={p} title={p}>
              {baseName(p)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ParamForm({
  fields,
  values,
  onChange,
  disabled,
}: ParamFormProps) {
  return (
    <div className="param-form">
      {fields.map((field) => {
        if (isFileLikeParamType(field.type)) {
          return (
            <FileFieldInput
              key={field.id}
              field={field}
              value={values[field.id]}
              disabled={disabled}
              onChange={onChange}
            />
          );
        }

        const value = values[field.id];
        const hint = [
          field.description,
        ]
          .filter(Boolean)
          .join(' · ');

        if (field.type === 'boolean') {
          return (
            <div className="field checkbox" key={field.id}>
              <input
                id={field.id}
                type="checkbox"
                checked={Boolean(value)}
                disabled={disabled}
                onChange={(e) => onChange(field.id, e.target.checked)}
              />
              <div>
                <label htmlFor={field.id}>{field.label}</label>
                {hint ? <div className="hint">{hint}</div> : null}
              </div>
            </div>
          );
        }

        if (field.type === 'text') {
          return (
            <div className="field" key={field.id}>
              <label htmlFor={field.id}>
                {field.label}
                {field.required ? ' *' : ''}
              </label>
              {hint ? <div className="hint">{hint}</div> : null}
              <MarkdownEditor
                id={field.id}
                disabled={disabled}
                placeholder={field.placeholder}
                value={String(value ?? '')}
                onChange={(next) => onChange(field.id, next)}
              />
            </div>
          );
        }

        if (field.type === 'enum') {
          return (
            <div className="field" key={field.id}>
              <label htmlFor={field.id}>
                {field.label}
                {field.required ? ' *' : ''}
              </label>
              {hint ? <div className="hint">{hint}</div> : null}
              <select
                id={field.id}
                disabled={disabled}
                value={String(value ?? '')}
                onChange={(e) => onChange(field.id, e.target.value)}
              >
                <option value="">—</option>
                {field.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        if (field.type === 'number') {
          return (
            <div className="field" key={field.id}>
              <label htmlFor={field.id}>
                {field.label}
                {field.required ? ' *' : ''}
              </label>
              {hint ? <div className="hint">{hint}</div> : null}
              <input
                id={field.id}
                type="number"
                disabled={disabled}
                min={field.min}
                max={field.max}
                step={field.step ?? 1}
                value={value === undefined || value === '' ? '' : Number(value)}
                onChange={(e) => {
                  const raw = e.target.value;
                  onChange(field.id, raw === '' ? '' : Number(raw));
                }}
              />
            </div>
          );
        }

        return (
          <div className="field" key={field.id}>
            <label htmlFor={field.id}>
              {field.label}
              {field.required ? ' *' : ''}
            </label>
            {hint ? <div className="hint">{hint}</div> : null}
            <input
              id={field.id}
              type="text"
              disabled={disabled}
              placeholder={field.placeholder}
              value={String(value ?? '')}
              onChange={(e) => onChange(field.id, e.target.value)}
            />
          </div>
        );
      })}
    </div>
  );
}
