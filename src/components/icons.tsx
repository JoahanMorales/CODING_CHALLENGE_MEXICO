// Small, consistent stroke icon set (Feather-style, currentColor) so the UI uses
// crafted iconography instead of emoji -- it reads like a designed product, not a
// generated one. All icons share a 24x24 viewBox, 1.75 stroke, round joins.

interface IconProps {
  className?: string;
  strokeWidth?: number;
}

function Svg({ className, strokeWidth = 1.75, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconTrophy(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 4h12v3a6 6 0 0 1-12 0V4z" />
      <path d="M6 5H3.5A1.5 1.5 0 0 0 2 6.5C2 9 4 10 6 10" />
      <path d="M18 5h2.5A1.5 1.5 0 0 1 22 6.5C22 9 20 10 18 10" />
      <path d="M9.5 13.5 9 18h6l-.5-4.5" />
      <path d="M7 21h10" />
      <path d="M12 18v3" />
    </Svg>
  );
}

export function IconCrown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8l3.5 3.5L12 4l5.5 7.5L21 8l-1.5 11h-15L3 8z" />
      <path d="M5.5 19h13" />
    </Svg>
  );
}

export function IconTrendUp(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="3 17 9.5 10.5 13.5 14.5 21 7" />
      <polyline points="15 7 21 7 21 13" />
    </Svg>
  );
}

export function IconZap(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
    </Svg>
  );
}

export function IconTarget(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" />
    </Svg>
  );
}

export function IconShield(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 22s7.5-3.5 7.5-9.5V5.5L12 2.5 4.5 5.5v7C4.5 18.5 12 22 12 22z" />
      <polyline points="9 12 11.5 14.5 15.5 9.5" />
    </Svg>
  );
}

export function IconGem(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3h12l3.5 6L12 21 2.5 9 6 3z" />
      <path d="M2.5 9h19" />
      <path d="M9 3 7 9l5 12 5-12-2-6" />
    </Svg>
  );
}

export function IconAward(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="9" r="6" />
      <path d="M8.5 14 7 22l5-2.8L17 22l-1.5-8" />
    </Svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="10.5" width="16" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </Svg>
  );
}
