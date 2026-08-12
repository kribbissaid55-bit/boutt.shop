/**
 * Pre-built follow-up templates. Each template is a list of step recipes —
 * the user picks one in the editor and the local state is replaced with these
 * steps. They can edit before saving.
 *
 * Block shape matches MessageSequenceJson in FollowUpRuleService.
 */

export type DelayUnit = 'minutes' | 'hours' | 'days';

export interface BlockRecipe {
  type: 'text' | 'image' | 'video' | 'audio' | 'document';
  content?: string;
  caption?: string;
  // mediaId is intentionally omitted — user picks files in the editor.
}

export interface StepRecipe {
  delayValue: number;
  delayUnit: DelayUnit;
  blocks: BlockRecipe[];
}

export interface FollowUpTemplate {
  key: string;
  /** i18n key under `t.followups.templates.<key>` for the human-readable name */
  steps: StepRecipe[];
}

export const FOLLOWUP_TEMPLATES: FollowUpTemplate[] = [
  {
    key: 'reengagement',
    steps: [
      {
        delayValue: 1, delayUnit: 'days',
        blocks: [
          { type: 'text', content: 'السلام، شفنا أنك زرتنا قبل شي مدة. واش كاينة شي مساعدة نقدرو نقدمولك؟' },
        ],
      },
      {
        delayValue: 3, delayUnit: 'days',
        blocks: [
          { type: 'text', content: 'عرض خاص لليوم فقط — راسلنا إذا بغيتي تفاصيل أكثر 👇' },
        ],
      },
    ],
  },
  {
    key: 'newproduct',
    steps: [
      {
        delayValue: 1, delayUnit: 'days',
        blocks: [
          { type: 'text', content: '🎉 وصلنا منتج جديد فالمتجر!' },
          { type: 'image', caption: 'شوف الصورة' },
          { type: 'text', content: 'الثمن: 199 درهم  ·  التوصيل مجاني داخل المدينة.\nبغيتي تطلبو؟' },
        ],
      },
      {
        delayValue: 4, delayUnit: 'days',
        blocks: [
          { type: 'text', content: 'آخر فرصة للحصول على المنتج الجديد. الكمية محدودة!' },
        ],
      },
    ],
  },
  {
    key: 'orderreminder',
    steps: [
      {
        delayValue: 6, delayUnit: 'hours',
        blocks: [
          { type: 'text', content: 'السلام، شي مشكل في الطلب؟ نقدرو نساعدوك تكمل التأكيد؟' },
        ],
      },
      {
        delayValue: 24, delayUnit: 'hours',
        blocks: [
          { type: 'text', content: 'إذا غيرت رأيك نقدرو نلغو الطلب أو نأجلوه. عافاك جاوبنا.' },
        ],
      },
    ],
  },
  {
    key: 'sale',
    steps: [
      {
        delayValue: 1, delayUnit: 'days',
        blocks: [
          { type: 'image', caption: '🔥 خصم -30٪ لمدة 24 ساعة فقط' },
          { type: 'text', content: 'سارع للطلب — العرض ينتهي اليوم!' },
        ],
      },
    ],
  },
];
