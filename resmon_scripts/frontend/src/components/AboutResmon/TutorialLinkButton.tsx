import React from 'react';
import { useNavigate } from 'react-router-dom';

interface TutorialLinkButtonProps {
  /**
   * Anchor id of the matching section in the Tutorials tab. Passed as the
   * location hash so the Tutorials tab can scroll the matching element
   * into view on mount.
   */
  anchor: string;
  /** Optional override for the button label. Defaults to "Tutorial". */
  label?: string;
}

/**
 * Shared deep-link button that jumps to the matching section of the
 * About resmon → Tutorials tab. Rendered next to each page's header
 * title and next to each Settings sub-panel header.
 */
const TutorialLinkButton: React.FC<TutorialLinkButtonProps> = ({ anchor, label = 'Tutorial' }) => {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="btn btn-sm btn-primary tutorial-link-btn"
      onClick={() => navigate({ pathname: '/about-resmon/tutorials', hash: anchor })}
      data-testid={`tutorial-link-${anchor}`}
      aria-label={`Open the ${anchor} tutorial`}
    >
      {label}
    </button>
  );
};

export default TutorialLinkButton;
