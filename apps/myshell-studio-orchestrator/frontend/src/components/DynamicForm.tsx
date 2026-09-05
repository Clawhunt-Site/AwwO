import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FormField } from "../types/form";

interface DynamicFormProps {
  fields: FormField[];
  values: Record<number, string>;
  uploadStates: Record<number, { uploading: boolean; error?: string }>;
  onChange: (index: number, value: string) => void;
  onUpload: (index: number, file: File) => void;
}

function normalizeOptions(
  options: Array<{ label: string; value: string; image?: string } | string>,
) {
  return options.map((opt) =>
    typeof opt === "string" ? { label: opt, value: opt, image: "" } : opt,
  );
}

function FieldUploader({
  field,
  imageUrl,
  uploading,
  error,
  onUpload,
}: {
  field: FormField;
  imageUrl: string;
  uploading: boolean;
  error?: string;
  onUpload: (file: File) => void;
}) {
  const { t } = useTranslation("upload");
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    onUpload(file);
  };

  return (
    <div className="flex flex-col gap-2 mb-4">
      <span className="text-base font-semibold text-Cr-text-static-white-v2">
        {field.title}
        {field.required !== false && (
          <span className="text-dreamy-brand-hot-v2 ml-0.5">*</span>
        )}
      </span>
      <div
        className={`bg-Cr-Bg-surface-default-v2 rounded-xl-v2 aspect-[4/3] flex flex-col items-center justify-center gap-2 cursor-pointer relative overflow-hidden border-2 border-dashed transition-[border-color] duration-150 active:opacity-85 ${
          dragOver
            ? "border-dreamy-brand-hot-v2"
            : error
              ? "border-Cr-border-critical-v2"
              : "border-transparent"
        }`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
      >
        {imageUrl ? (
          <img
            className="w-full h-full object-cover block"
            src={imageUrl}
            alt="uploaded"
          />
        ) : (
          <>
            <div className="[&>svg]:w-9 [&>svg]:h-9 text-Cr-text-subtler-v2">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <span className="text-sm text-Cr-text-subtler-v2">
              {t("tapToUpload")}
            </span>
          </>
        )}
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 rounded-xl-v2">
            <div className="w-8 h-8 border-3 border-dreamy-brand-hot-v2 border-t-transparent rounded-full animate-[spin_0.6s_linear_infinite]" />
          </div>
        )}
      </div>
      {error && (
        <span className="text-xs text-Cr-text-critical-default-v2">
          {error}
        </span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

export default function DynamicForm({
  fields,
  values,
  uploadStates,
  onChange,
  onUpload,
}: DynamicFormProps) {
  const { t } = useTranslation("upload");
  return (
    <div>
      {fields.map((field, index) => {
        const value = values[index] ?? field.default ?? "";
        const required = field.required !== false;

        switch (field.component) {
          case "Uploader":
            return (
              <FieldUploader
                key={index}
                field={field}
                imageUrl={value}
                uploading={uploadStates[index]?.uploading ?? false}
                error={uploadStates[index]?.error}
                onUpload={(file) => onUpload(index, file)}
              />
            );

          case "Prompt":
            return (
              <div key={index} className="flex flex-col gap-2 mb-4">
                <span className="text-base font-semibold text-Cr-text-static-white-v2">
                  {field.title}
                  {required && (
                    <span className="text-dreamy-brand-hot-v2 ml-0.5">*</span>
                  )}
                </span>
                <textarea
                  className="w-full bg-Cr-Bg-surface-default-v2 border-0 rounded-xl-v2 text-Cr-text-static-white-v2 text-base py-[14px] px-4 min-h-20 resize-none font-[inherit] outline-none box-border placeholder:text-Cr-text-subtler-v2"
                  value={value}
                  onChange={(e) => onChange(index, e.target.value)}
                  placeholder={t("enterYourText")}
                  rows={3}
                />
              </div>
            );

          case "RadioGroup":
            return (
              <div key={index} className="flex flex-col gap-2 mb-4">
                <span className="text-base font-semibold text-Cr-text-static-white-v2">
                  {field.title}
                  {required && (
                    <span className="text-dreamy-brand-hot-v2 ml-0.5">*</span>
                  )}
                </span>
                <div className="flex flex-wrap gap-2">
                  {normalizeOptions(field.options).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`py-[10px] px-4 rounded-[10px] text-sm border-[1.5px] cursor-pointer transition-all duration-150 active:opacity-70 ${
                        value === opt.value
                          ? "border-dreamy-brand-hot-v2 bg-[rgba(255,25,94,0.12)] text-dreamy-brand-hot-v2"
                          : "border-white/10 bg-Cr-Bg-surface-default-v2 text-Cr-text-subtle-v2"
                      }`}
                      onClick={() => onChange(index, opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            );

          case "ImageChoices":
            return (
              <div key={index} className="flex flex-col gap-2 mb-4">
                <span className="text-base font-semibold text-Cr-text-static-white-v2">
                  {field.title}
                  {required && (
                    <span className="text-dreamy-brand-hot-v2 ml-0.5">*</span>
                  )}
                </span>
                <div className="grid grid-cols-3 gap-2">
                  {normalizeOptions(field.options).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`flex flex-col items-center gap-1 p-1.5 rounded-[10px] border-2 cursor-pointer transition-[border-color] duration-150 active:opacity-70 ${
                        value === opt.value
                          ? "border-dreamy-brand-hot-v2 bg-Cr-Bg-surface-default-v2"
                          : "border-transparent bg-Cr-Bg-surface-default-v2"
                      }`}
                      onClick={() => onChange(index, opt.value)}
                    >
                      {opt.image && (
                        <img
                          className="w-full aspect-square object-cover rounded-lg-v2"
                          src={opt.image}
                          alt={opt.label}
                        />
                      )}
                      <span className="text-xs text-Cr-text-subtler-v2 text-center overflow-hidden text-ellipsis whitespace-nowrap w-full">
                        {opt.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );

          case "Selector":
            return (
              <div key={index} className="flex flex-col gap-2 mb-4">
                <span className="text-base font-semibold text-Cr-text-static-white-v2">
                  {field.title}
                  {required && (
                    <span className="text-dreamy-brand-hot-v2 ml-0.5">*</span>
                  )}
                </span>
                <select
                  className="w-full py-[14px] px-4 border-0 rounded-xl-v2 bg-Cr-Bg-surface-default-v2 text-Cr-text-static-white-v2 text-base font-[inherit] appearance-none cursor-pointer outline-none"
                  value={value}
                  onChange={(e) => onChange(index, e.target.value)}
                >
                  <option value="">{t("select")}</option>
                  {normalizeOptions(field.options).map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            );

          default:
            return null;
        }
      })}
    </div>
  );
}
