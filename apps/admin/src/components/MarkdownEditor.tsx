import MDEditor from '@uiw/react-md-editor';
import '@uiw/react-md-editor/markdown-editor.css';
import '@uiw/react-markdown-preview/markdown.css';

export function MarkdownEditor({
  id,
  value,
  disabled,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  // Keep preview="live" always — toggling to "preview" when disabled remounts
  // the editor and leaves a plain textarea until full page reload.
  return (
    <div
      className={`markdown-editor${disabled ? ' is-disabled' : ''}`}
      data-color-mode="light"
    >
      <MDEditor
        value={value}
        height={260}
        visibleDragbar={false}
        preview="live"
        textareaProps={{
          id,
          name: id,
          placeholder,
          disabled,
          readOnly: disabled,
        }}
        onChange={(next) => {
          if (disabled) return;
          onChange(next ?? '');
        }}
      />
    </div>
  );
}
