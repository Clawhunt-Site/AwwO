import { useState, useRef, useCallback, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useTelegramBackButton } from '../hooks/useTelegram';
import { uploadImage, fetchBotDetail, generate, isNeedStoreRedirect } from '../services/api';
import { trackEvent } from '../services/tracking';
import type { FormField } from '../types/form';
import type { BotSingleText } from '../types';
import CustomizeSceneModal from '../components/CustomizeSceneModal';
import { useEnergy } from '../contexts/EnergyContext';
import {
  SceneOptions,
  shouldShowCustomizeScene,
  submitGenerateWithOptions,
} from '../services/customizeScene';
import exampleGood from '../assets/example-good.png';
import exampleBlocked from '../assets/example-blocked.png';
import exampleSmall from '../assets/example-small.png';
import exampleMultiple from '../assets/example-multiple.png';

const EXAMPLES = [
  { labelKey: 'upload:singleFace', good: true, img: exampleGood },
  { labelKey: 'upload:faceBlocked', good: false, img: exampleBlocked },
  { labelKey: 'upload:faceTooSmall', good: false, img: exampleSmall },
  { labelKey: 'upload:multipleFaces', good: false, img: exampleMultiple },
];

const SAMPLE_PHOTOS = [
  { id: 'm_young', labelKey: 'upload:sampleMaleYoung', url: 'https://www.myshellstatic.com/cdn-cgi/image/width=1024,height=1024,quality=90,format=webp,fit=scale-down/image/bot/image_gen/202604300644/m_young.png' },
  { id: 'm_mature', labelKey: 'upload:sampleMaleMature', url: 'https://www.myshellstatic.com/cdn-cgi/image/width=1024,height=1024,quality=90,format=webp,fit=scale-down/image/bot/image_gen/202604300644/m_mature.png' },
  { id: 'm_old', labelKey: 'upload:sampleMaleOld', url: 'https://www.myshellstatic.com/cdn-cgi/image/width=1024,height=1024,quality=90,format=webp,fit=scale-down/image/bot/image_gen/202604300644/m_old.png' },
  { id: 'f_young', labelKey: 'upload:sampleFemaleYoung', url: 'https://www.myshellstatic.com/cdn-cgi/image/width=1024,height=1024,quality=90,format=webp,fit=scale-down/image/bot/image_gen/202604300644/f_young.png' },
  { id: 'f_mature', labelKey: 'upload:sampleFemaleMature', url: 'https://www.myshellstatic.com/cdn-cgi/image/width=1024,height=1024,quality=90,format=webp,fit=scale-down/image/bot/image_gen/202604300644/f_mature.png' },
  { id: 'f_old', labelKey: 'upload:sampleFemaleOld', url: 'https://www.myshellstatic.com/cdn-cgi/image/width=1024,height=1024,quality=90,format=webp,fit=scale-down/image/bot/image_gen/202604300644/f_old.png' },
];

const DEFAULT_EXTRA_FIELDS: FormField[] = [];

// Safely extract value from first option, handling both string[] and FormFieldOption[] shapes.
function firstOptionValue(options: FormField['options'] | undefined): string {
  const first = options?.[0];
  if (!first) return '';
  return typeof first === 'string' ? first : first.value || '';
}

interface UploaderField {
  title: string;
  index: number;
}

export default function Upload() {
  const { t } = useTranslation('upload');
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { isVip, energy } = useEnergy();
  const slugId = searchParams.get('slug_id') || '';
  const isTagGeneratorMode = searchParams.get('mode') === 'tag-generator';
  const fileRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const selectedFilesRef = useRef<Record<number, File | null>>({});

  const goBack = useCallback(() => navigate(-1), [navigate]);
  useTelegramBackButton(goBack);

  const [ready, setReady] = useState(false);
  const [previews, setPreviews] = useState<Record<number, string | null>>({});
  const [selectedSampleUrls, setSelectedSampleUrls] = useState<Record<number, string | null>>({});
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [uploaderFields, setUploaderFields] = useState<UploaderField[]>([]);
  const [extraFields, setExtraFields] = useState<FormField[]>(DEFAULT_EXTRA_FIELDS);
  const [fieldValues, setFieldValues] = useState<Record<number, string>>({});
  const [buttonText, setButtonText] = useState('');
  const [sceneModalOpen, setSceneModalOpen] = useState(false);
  // Accept botId + singleText from BotDetail page via navigation state
  const passedBotId = (history.state?.usr?.botId as string) || '';
  const passedArticleId = (history.state?.usr?.articleId as string) || '';
  const passedSingleText = (history.state?.usr?.singleText as BotSingleText) || null;
  const [botId, setBotId] = useState<string>(passedBotId);
  const [articleId, setArticleId] = useState<string>(passedArticleId);

  // Track Example Photos section view
  const sampleViewTracked = useRef(false);

  // Track Example Photos section view once when ready
  useEffect(() => {
    if (ready && !sampleViewTracked.current) {
      trackEvent('miniapp_sample_view', { bot_id: botId, slug_id: slugId });
      sampleViewTracked.current = true;
    }
  }, [ready, botId, slugId]);

  useEffect(() => {
    if (!slugId) { setReady(true); return; }

    // If singleText was passed from BotDetail, use it directly
    if (passedSingleText?.form) {
      const uploaders = passedSingleText.form
        .filter((f) => f.component === 'Uploader')
        .map((f): UploaderField => ({
          title: f.title,
          index: f.index ?? 0,
        }))
        .sort((a, b) => a.index - b.index);
      // Fallback: if no uploaders defined, create a default one
      setUploaderFields(uploaders.length > 0 ? uploaders : [{ title: '', index: 0 }]);
      const nonUploader = passedSingleText.form
        .filter((f) => f.component !== 'Uploader')
        .map((f): FormField => ({
          title: f.title,
          component: f.component as FormField['component'],
          index: f.index,
          options: f.options || [],
          default: f.default || '',
          required: false,
        }));
      setExtraFields(nonUploader);
      const defaults: Record<number, string> = {};
      nonUploader.forEach((f, i) => {
        // Prefill default if provided; otherwise fallback to first option for choice-type fields
        // to avoid submitting empty values (which cause widget 500 for required positional slots).
        if (f.default) {
          defaults[i] = f.default;
        } else if (
          f.component === 'ImageChoices' || f.component === 'Selector' || f.component === 'RadioGroup'
        ) {
          const fallback = firstOptionValue(f.options);
          if (fallback) defaults[i] = fallback;
        }
      });
      setFieldValues(defaults);
      if (passedSingleText.button_text) setButtonText(passedSingleText.button_text);
      setReady(true);
      return;
    }

    // Fallback: fetch bot detail if not passed
    fetchBotDetail(slugId).catch(() => null).then((detail) => {
      if (detail?.info?.botId) setBotId(detail.info.botId);
      if (detail?.info?.slugId) setArticleId(detail.info.slugId);
      if (detail?.info?.singleText) {
        try {
          const st = JSON.parse(detail.info.singleText) as BotSingleText;
          const uploaders = (st.form || [])
            .filter((f) => f.component === 'Uploader')
            .map((f): UploaderField => ({
              title: f.title,
              index: f.index ?? 0,
            }))
            .sort((a, b) => a.index - b.index);
          // Fallback: if no uploaders defined, create a default one
          setUploaderFields(uploaders.length > 0 ? uploaders : [{ title: '', index: 0 }]);
          const nonUploader = (st.form || [])
            .filter((f) => f.component !== 'Uploader')
            .map((f): FormField => ({
              title: f.title,
              component: f.component as FormField['component'],
              index: f.index,
              options: f.options || [],
              default: f.default || '',
              required: false,
            }));
          setExtraFields(nonUploader);
          const defaults: Record<number, string> = {};
          nonUploader.forEach((f, i) => {
            if (f.default) {
              defaults[i] = f.default;
            } else if (
              f.component === 'ImageChoices' || f.component === 'Selector' || f.component === 'RadioGroup'
            ) {
              const fallback = firstOptionValue(f.options);
              if (fallback) defaults[i] = fallback;
            }
          });
          setFieldValues(defaults);
          if (st.button_text) setButtonText(st.button_text);
        } catch { /* use defaults */ }
      }
      setReady(true);
    });
  }, [slugId]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleFileChange = useCallback((uploaderIndex: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    selectedFilesRef.current[uploaderIndex] = file;
    setSelectedSampleUrls((prev) => ({ ...prev, [uploaderIndex]: null })); // user's own upload overrides any picked sample
    setPreviews((prev) => ({ ...prev, [uploaderIndex]: URL.createObjectURL(file) }));
    trackEvent('miniapp_upload_image', { bot_id: botId, slug_id: slugId, image_count: 1, uploader_index: uploaderIndex });
    e.target.value = '';
  }, [botId, slugId]);

  const runGenerateWithImages = useCallback(async (imageUrls: string[], scene?: SceneOptions) => {
    if (!slugId || loading) return;
    setLoading(true);
    try {
      // Collect input params: all image URLs first (in uploader order), then extra field values (positional mapping)
      const inputImg: string[] = [...imageUrls];
      const shellFields: Record<string, string> = {};
      extraFields.forEach((f, i) => {
        // Resolve value with fallback: user selection → field default → first option (for choice fields).
        // Always push to inputImg to preserve positional mapping required by backend widget.
        let val = fieldValues[i];
        if (!val) val = f.default || '';
        if (
          !val &&
          (f.component === 'ImageChoices' || f.component === 'Selector' || f.component === 'RadioGroup')
        ) {
          val = firstOptionValue(f.options) || '';
        }
        inputImg.push(val);
        if (val) shellFields[f.title] = val;
      });
      const shellJson = Object.keys(shellFields).length > 0 ? JSON.stringify(shellFields) : undefined;
      if (scene) {
        await submitGenerateWithOptions({ botId, slugId, inputImg, scene, articleId, shellJson });
      } else {
        await generate(botId || slugId, inputImg, articleId, shellJson);
      }
      try { window.Telegram?.WebApp?.close(); } catch { /* noop */ }
    } catch (err) {
      if (isNeedStoreRedirect(err)) {
        showToast(t('upload:redirectingToStore'));
        setTimeout(() => navigate('/energy'), 1500);
      } else {
        showToast(err instanceof Error ? err.message : t('upload:generationFailed'));
      }
    } finally {
      setLoading(false);
    }
  }, [slugId, extraFields, fieldValues, loading, showToast, botId, articleId, navigate, t]);

  const doGenerate = useCallback(async (scene?: SceneOptions) => {
    if (loading || !slugId) return;

    // Capture energy balance before generation (for tracking). Backend is the source of truth;
    // proxy for "user believes they have enough to attempt". Backend is source of truth.
    const balanceBefore = energy ?? 0;
    const hasEnoughEnergy = balanceBefore > 0;

    // Collect all image URLs in uploader order
    const imageUrls: string[] = [];
    const filesToUpload: File[] = [];

    for (const uploader of uploaderFields) {
      const idx = uploader.index;
      const sampleUrl = selectedSampleUrls[idx];
      const file = selectedFilesRef.current[idx];

      if (sampleUrl && !file) {
        // User picked a sample for this slot
        imageUrls.push(sampleUrl);
      } else if (file) {
        // User uploaded a file for this slot — mark for upload
        filesToUpload.push(file);
        imageUrls.push(''); // placeholder, will be replaced after upload
      } else {
        // No image provided for this slot (shouldn't happen if button is properly disabled)
        return;
      }
    }

    // Track sample usage (only for single uploader case with sample)
    if (uploaderFields.length === 1 && selectedSampleUrls[uploaderFields[0].index] && !selectedFilesRef.current[uploaderFields[0].index]) {
      const sample = SAMPLE_PHOTOS.find((s) => s.url === selectedSampleUrls[uploaderFields[0].index]);
      const sampleId = sample?.id ?? 'unknown';
      trackEvent('miniapp_upload_skipped', { bot_id: botId, slug_id: slugId, sample_id: sampleId });
    }

    trackEvent('miniapp_generate_click', {
      bot_id: botId,
      slug_id: slugId,
      energy_balance_before: balanceBefore,
      has_enough_energy: hasEnoughEnergy,
    });

    // Upload all files if needed
    if (filesToUpload.length > 0) {
      setLoading(true);
      try {
        const uploadedUrls = await Promise.all(filesToUpload.map((file) => uploadImage(file)));
        // Replace placeholders with actual uploaded URLs
        let uploadIdx = 0;
        for (let i = 0; i < imageUrls.length; i++) {
          if (imageUrls[i] === '') {
            imageUrls[i] = uploadedUrls[uploadIdx++];
          }
        }
      } catch (err) {
        if (isNeedStoreRedirect(err)) {
          showToast(t('upload:redirectingToStore'));
          setTimeout(() => navigate('/energy'), 1500);
        } else {
          showToast(err instanceof Error ? err.message : t('upload:generationFailed'));
        }
        setLoading(false);
        return;
      }
    }

    await runGenerateWithImages(imageUrls, scene);
  }, [slugId, loading, showToast, runGenerateWithImages, botId, t, navigate, uploaderFields, selectedSampleUrls, energy]);

  const handleGenerate = useCallback(() => {
    if (loading) return;

    // Tag Generator mode: upload first image only, then navigate to tag selection
    if (isTagGeneratorMode) {
      // In tag-generator mode, only use the first uploader (index 0)
      const firstUploader = uploaderFields[0];
      if (!firstUploader) return;

      const idx = firstUploader.index;
      const file = selectedFilesRef.current[idx];
      const sampleUrl = selectedSampleUrls[idx];
      if (!file && !sampleUrl) return;

      setLoading(true);
      (async () => {
        try {
          let imageUrl: string;
          if (sampleUrl && !file) {
            imageUrl = sampleUrl;
          } else if (file) {
            imageUrl = await uploadImage(file);
          } else {
            return;
          }
          trackEvent('sd_photo_uploaded', { slug_id: slugId });
          navigate(`/tag-generator?slug_id=${encodeURIComponent(slugId)}&img=${encodeURIComponent(imageUrl)}`);
        } catch (err) {
          showToast(err instanceof Error ? err.message : 'Upload failed');
        } finally {
          setLoading(false);
        }
      })();
      return;
    }

    if (shouldShowCustomizeScene(slugId)) {
      trackEvent('miniapp_customize_scene_open', {
        bot_id: botId,
        slug_id: slugId,
        vip_unlocked: Boolean(isVip),
      });
      setSceneModalOpen(true);
      return;
    }
    void doGenerate();
  }, [botId, slugId, loading, doGenerate, isVip, isTagGeneratorMode, uploaderFields, selectedSampleUrls, navigate, showToast]);

  const handleSceneSubmit = useCallback((scene: SceneOptions) => {
    setSceneModalOpen(false);
    void doGenerate(scene);
  }, [doGenerate]);

  const handleSamplePrefill = useCallback((uploaderIndex: number, sampleUrl: string, sampleId: string) => {
    if (loading) return;
    // Prefill sample into upload area as if user picked it; user still must click Generate.
    selectedFilesRef.current[uploaderIndex] = null;
    setSelectedSampleUrls((prev) => ({ ...prev, [uploaderIndex]: sampleUrl }));
    setPreviews((prev) => ({ ...prev, [uploaderIndex]: sampleUrl }));
    trackEvent('miniapp_sample_clicked', { bot_id: botId, slug_id: slugId, sample_id: sampleId, uploader_index: uploaderIndex });
  }, [loading, botId, slugId]);

  if (!ready) return null;

  // Check if all uploader slots have an image (either uploaded or sample-prefilled)
  const allUploadersFilled = uploaderFields.every((uploader) => {
    const idx = uploader.index;
    return previews[idx] || selectedSampleUrls[idx];
  });

  return (
    <div className="h-full overflow-y-auto flex flex-col bg-Cr-Bg-soft-v2">
      {/* NavBar */}
      <div className="flex items-center justify-center relative py-3 px-4 shrink-0">
        <span className="text-[17px] font-semibold text-Cr-text-default-v2">{t('upload:uploadImage')}</span>
      </div>

      <div className="flex-1 px-4 pb-[100px]">
        {/* Examples */}
        <div className="text-base font-semibold text-Cr-text-default-v2 mt-4 mb-2">{t('upload:examples')}</div>
        <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-none [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden">
          {EXAMPLES.map((ex, i) => (
            <div className="shrink-0 flex flex-col items-center gap-1" key={i}>
              <div className="w-20 h-20 rounded-lg-v2 relative overflow-hidden">
                <img className="w-full h-full object-cover block" src={ex.img} alt={t(ex.labelKey)} />
                <div
                  className={`absolute bottom-1 right-1 w-5 h-5 rounded-full flex items-center justify-center text-xs text-white font-bold ${ex.good ? 'bg-dreamy-badge-good-v2' : 'bg-dreamy-badge-bad-v2'}`}
                >
                  {ex.good ? '✓' : '✗'}
                </div>
              </div>
              <span className="text-xs text-Cr-text-subtler-v2 whitespace-nowrap">{t(ex.labelKey)}</span>
            </div>
          ))}
        </div>

        {/* Upload areas — render one per Uploader field */}
        {uploaderFields.map((uploader, uploaderIdx) => {
          const idx = uploader.index;
          const preview = previews[idx];
          return (
            <div key={idx}>
              <div className="text-base font-semibold text-Cr-text-default-v2 mt-4 mb-2">{uploader.title || t('upload:faceImage')}</div>
              <div
                className="bg-Cr-Bg-surface-default-v2 rounded-xl-v2 aspect-[4/3] flex flex-col items-center justify-center gap-2 cursor-pointer relative overflow-hidden active:opacity-[0.85] mx-4"
                onClick={() => fileRefs.current[idx]?.click()}
              >
                {preview ? (
                  <>
                    <img className="w-full h-full object-cover block" src={preview} alt="Preview" />
                    <button
                      className="absolute top-2.5 right-2.5 w-8 h-8 rounded-lg-v2 bg-black/50 border-none flex items-center justify-center cursor-pointer active:opacity-70 [&_svg]:w-[18px] [&_svg]:h-[18px] [&_svg]:text-white"
                      onClick={(e) => { e.stopPropagation(); fileRefs.current[idx]?.click(); }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                        <path d="m15 5 4 4" />
                      </svg>
                    </button>
                  </>
                ) : (
                  <>
                    <div className="w-12 h-12 flex items-center justify-center [&_svg]:w-9 [&_svg]:h-9 [&_svg]:text-Cr-text-subtler-v2">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                    </div>
                    <span className="text-sm text-Cr-text-subtler-v2">{t('upload:tapToUpload')}</span>
                  </>
                )}
              </div>
              <input
                ref={(el) => { fileRefs.current[idx] = el; }}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileChange(idx)}
              />
            </div>
          );
        })}

        {/* Extra fields from form config (or default Description) — hidden in tag-generator mode */}
        {!isTagGeneratorMode && extraFields.map((field, i) => {
          const value = fieldValues[i] ?? '';

          if (field.component === 'Prompt') {
            return (
              <div key={i}>
                <div className="text-base font-semibold text-Cr-text-default-v2 mt-4 mb-2">{field.title}</div>
                <textarea
                  className="w-full bg-Cr-Bg-surface-default-v2 border-none rounded-xl-v2 text-Cr-text-default-v2 text-base py-[14px] px-4 min-h-20 resize-none font-[inherit] outline-none box-border placeholder:text-Cr-text-subtler-v2"
                  placeholder={t('upload:enterDescription')}
                  value={value}
                  onChange={(e) => setFieldValues((prev) => ({ ...prev, [i]: e.target.value }))}
                  onBlur={() => trackEvent('miniapp_form_choose', { bot_id: botId, slug_id: slugId, field: 'prompt' })}
                  rows={3}
                />
              </div>
            );
          }

          if (field.component === 'RadioGroup') {
            const opts = field.options.map((o) => typeof o === 'string' ? { label: o, value: o } : o);
            return (
              <div key={i}>
                <div className="text-base font-semibold text-Cr-text-default-v2 mt-4 mb-2">{field.title}</div>
                <div className="flex flex-wrap gap-2">
                  {opts.map((opt) => {
                    const active = value === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        className={`py-2.5 px-4 rounded-[10px] text-sm border-[1.5px] cursor-pointer transition-all duration-150 active:opacity-70 ${active ? 'border-dreamy-brand-hot-v2 bg-dreamy-brand-hot-v2/[0.12] text-dreamy-brand-hot-v2' : 'border-white/10 bg-Cr-Bg-surface-default-v2 text-Cr-text-subtle-v2'}`}
                        onClick={() => {
                          setFieldValues((prev) => ({ ...prev, [i]: opt.value }));
                          trackEvent('miniapp_form_choose', { bot_id: botId, slug_id: slugId, field: 'style' });
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          }

          if (field.component === 'ImageChoices') {
            const opts = field.options.map((o) => typeof o === 'string' ? { label: o, value: o, icon: '' } : o);
            return (
              <div key={i}>
                <div className="text-base font-semibold text-Cr-text-default-v2 mt-4 mb-2">{field.title}</div>
                <div className="grid grid-cols-3 gap-2">
                  {opts.map((opt) => {
                    const active = value === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        className={`bg-Cr-Bg-surface-default-v2 border-2 rounded-[10px] overflow-hidden cursor-pointer p-0 flex flex-col transition-colors duration-150 active:opacity-80 ${active ? 'border-dreamy-brand-hot-v2' : 'border-transparent'}`}
                        onClick={() => {
                          setFieldValues((prev) => ({ ...prev, [i]: opt.value }));
                          trackEvent('miniapp_form_choose', { bot_id: botId, slug_id: slugId, field: 'style' });
                        }}
                      >
                        <img src={opt.value} alt={opt.label} className="w-full aspect-square object-cover block" loading="lazy" />
                        <span className={`py-1.5 px-1 text-xs font-medium text-center whitespace-nowrap overflow-hidden text-ellipsis ${active ? 'text-Cr-text-default-v2' : 'text-Cr-text-subtler-v2'}`}>
                          {opt.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          }

          if (field.component === 'Selector') {
            const opts = field.options.map((o) => typeof o === 'string' ? { label: o, value: o } : o);
            return (
              <div key={i}>
                <div className="text-base font-semibold text-Cr-text-default-v2 mt-4 mb-2">{field.title}</div>
                <select
                  className="w-full bg-Cr-Bg-surface-default-v2 border-none rounded-xl-v2 text-Cr-text-default-v2 text-base py-[14px] px-4 font-[inherit] outline-none box-border"
                  value={value}
                  onChange={(e) => {
                    setFieldValues((prev) => ({ ...prev, [i]: e.target.value }));
                    trackEvent('miniapp_form_choose', { bot_id: botId, slug_id: slugId, field: 'style' });
                  }}
                >
                  <option value="">{t('upload:select')}</option>
                  {opts.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            );
          }

          return null;
        })}

        {/* Privacy Notice */}
        <div className="flex items-center justify-center gap-1.5 mt-5 mb-3" data-testid="privacy-notice">
          <svg className="w-3.5 h-3.5 text-Cr-text-subtler-v2 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span className="text-xs text-Cr-text-subtler-v2 text-center">{t('upload:privacyNotice')}</span>
        </div>

        {/* Sample photos section — only show when there is exactly ONE uploader */}
        {uploaderFields.length === 1 && (
          <>
            {/* "or try with an example" divider */}
            <div className="flex items-center gap-3 mt-5 mb-3" data-testid="sample-divider">
              <div className="flex-1 h-px bg-white/10" />
              <span className="text-xs text-Cr-text-subtler-v2 whitespace-nowrap">{t('upload:orTryExample')}</span>
              <div className="flex-1 h-px bg-white/10" />
            </div>

            {/* Example Photos */}
            <div className="mt-2 mb-4" data-testid="example-photos-section">
              <div className="grid grid-cols-3 gap-2">
                {SAMPLE_PHOTOS.map((sample) => (
                  <div
                    key={sample.id}
                    className="relative rounded-xl-v2 overflow-hidden cursor-pointer active:opacity-80 transition-opacity"
                    data-testid="sample-photo"
                    data-sample-id={sample.id}
                    onClick={() => handleSamplePrefill(uploaderFields[0].index, sample.url, sample.id)}
                  >
                    <img
                      src={sample.url}
                      alt={t(sample.labelKey)}
                      className="w-full aspect-square object-cover block"
                      loading="lazy"
                    />
                    <div className="absolute bottom-0 left-0 right-0 bg-linear-to-t from-black/70 to-transparent py-1.5 px-2">
                      <span className="text-xs text-white font-medium">{t(sample.labelKey)}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="text-xs text-Cr-text-subtler-v2 text-center mt-2">{t('upload:examplePhotosHint')}</div>
            </div>
          </>
        )}
      </div>

      {/* Bottom Generate */}
      <div className="fixed bottom-0 left-0 right-0 py-3 px-4 pb-[max(12px,env(safe-area-inset-bottom))] bg-Cr-Bg-soft-v2">
        <button
          className="w-full p-4 border-none rounded-xl-v2 text-[17px] font-semibold text-white bg-linear-to-r from-dreamy-generate-from-v2 to-dreamy-generate-to-v2 cursor-pointer transition-opacity duration-150 active:opacity-[0.85] disabled:bg-none disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2 disabled:cursor-not-allowed disabled:active:opacity-100"
          disabled={!allUploadersFilled || loading}
          onClick={handleGenerate}
        >
          {loading ? t('upload:generating') : isTagGeneratorMode ? 'Next' : (buttonText || t('upload:generate'))}
        </button>
      </div>

      {toast && (
        <div className="fixed top-[60px] left-1/2 -translate-x-1/2 bg-[rgba(50,50,50,0.95)] text-Cr-text-default-v2 py-3 px-5 rounded-[10px] text-sm text-center z-[1000] animate-[fadeIn_0.2s_ease] max-w-[calc(100%-48px)]">
          {toast}
        </div>
      )}

      {sceneModalOpen && (
        <CustomizeSceneModal
          botId={botId}
          slugId={slugId}
          onClose={() => setSceneModalOpen(false)}
          onSubmit={handleSceneSubmit}
          onRequestUpgrade={() => {
            setSceneModalOpen(false);
            navigate('/energy');
          }}
        />
      )}
    </div>
  );
}
