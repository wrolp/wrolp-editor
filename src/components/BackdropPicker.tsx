import { t } from "../lib/i18n";

interface Props {
  /** `checker`, or a `#rrggbb` colour. The backend keeps only those two shapes. */
  value: string;
  onChange: (value: string) => void;
}

/**
 * The two colours worth a single click: white to read a dark artwork on, black for a pale one.
 * Anything else is asked of the browser's own picker, which is why the last control is a colour
 * input rather than a longer list of names that would have to be described instead of shown.
 */
const PRESETS = [
  { value: "#ffffff", label: "img.backdropWhite" },
  { value: "#000000", label: "img.backdropBlack" },
];

/**
 * The row that picks what sits behind a picture's transparent pixels.
 *
 * Every control is a swatch of what it would paint, so the choice is made on the colour rather
 * than on a word for it — and the row works unchanged in the picture's own toolbar and in
 * Settings, the two places the app lets this be set.
 */
export default function BackdropPicker({ value, onChange }: Props) {
  const checker = value === "checker";
  const preset = PRESETS.some((item) => item.value === value);
  return (
    <div className="bd-picker" role="group" aria-label={t("img.backdrop")}>
      <button
        type="button"
        className={`bd-swatch is-checker${checker ? " active" : ""}`}
        title={t("img.backdropChecker")}
        aria-label={t("img.backdropChecker")}
        aria-pressed={checker}
        onClick={() => onChange("checker")}
      />
      {PRESETS.map((item) => (
        <button
          key={item.value}
          type="button"
          className={`bd-swatch${value === item.value ? " active" : ""}`}
          style={{ background: item.value }}
          title={t(item.label)}
          aria-label={t(item.label)}
          aria-pressed={value === item.value}
          onClick={() => onChange(item.value)}
        />
      ))}
      <label
        className={`bd-swatch is-custom${!checker && !preset ? " active" : ""}`}
        style={checker || preset ? undefined : { background: value }}
        title={t("img.backdropCustom")}
      >
        {/* The invisible input still receives the click, which is what opens the system dialog;
            the label wears the colour, so the swatch is the control's only face. A mid grey is
            what the dialog starts from while the backdrop is the theme's checkerboard, because
            there is no colour to show until one is picked. */}
        <input
          type="color"
          value={checker ? "#808080" : value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={t("img.backdropCustom")}
        />
      </label>
    </div>
  );
}
