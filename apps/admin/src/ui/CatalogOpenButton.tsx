import { Chat, Play } from '@carbon/icons-react';
import { Button } from '@carbon/react';

export interface CatalogOpenButtonProps {
  mode: 'interactive' | 'autonomous';
  onClick: () => void;
}

export function CatalogOpenButton({ mode, onClick }: CatalogOpenButtonProps) {
  if (mode === 'interactive') {
    return (
      <Button
        kind="primary"
        size="sm"
        renderIcon={Chat}
        className="ops-catalog-open-btn"
        onClick={onClick}
      >
        Open in Chat
      </Button>
    );
  }

  return (
    <Button
      kind="primary"
      size="sm"
      renderIcon={Play}
      className="ops-catalog-open-btn"
      onClick={onClick}
    >
      Run as Job
    </Button>
  );
}
