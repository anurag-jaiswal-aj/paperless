import { Link } from 'react-router-dom';
import { MdArrowForward, MdEditNote, MdSend, MdDataset, MdPsychology, MdAutoFixHigh, MdRefresh, MdFormatAlignLeft, MdVerified, MdHealthAndSafety, MdWarning } from 'react-icons/md';
import PencilCursor from '../components/PencilCursor';
import PencilTrail from '../components/PencilTrail';
import LandingSectionNav from '../components/LandingSectionNav';

const Home = () => {
  return (
    <div className="w-full pt-[64px] bg-stitch-surface-container-lowest min-h-screen md:cursor-none select-none relative">


      <LandingSectionNav />
      <PencilCursor />
      <PencilTrail />

      <div className="flex flex-col w-full relative z-10">
{/*  HERO SECTION  */}
<section id="landing-hero" className="relative w-full max-w-[1200px] mx-auto px-[32px] pt-12 pb-[40px] min-h-[calc(100vh-64px)] flex flex-col justify-center items-center">
{/*  Badge / Subtitle  */}
<div className="inline-flex items-center gap-2 px-3 py-1 rounded bg-stitch-surface-container border border-stitch-outline-variant mb-6">
<span className="w-1.5 h-1.5 rounded-full bg-[#FF3B30] animate-pulse motion-reduce:animate-none" aria-hidden="true"></span>
<span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase tracking-wider text-stitch-secondary">AI-Native Form Builder</span>
</div>
{/*  Headline  */}
<h1 className="font-['Geist',sans-serif] text-[40px] md:text-[72px] leading-[48px] md:leading-[80px] tracking-[-0.035em] font-semibold text-stitch-primary text-center tracking-tight max-w-4xl mb-6">
      Build better forms.<br/>Understand every response.
    </h1>
{/*  Supporting copy  */}
<p className="font-['Geist',sans-serif] text-[18px] leading-[28px] tracking-[-0.01em] text-stitch-on-surface-variant text-center max-w-2xl mb-8">
      Paperless combines an intelligent form builder with AI-powered response analysis, so you can create, collect, and understand information in one place.
    </p>
{/*  CTAs  */}
<div className="flex items-center gap-[8px] mb-4">
<Link className="inline-flex items-center gap-[4px] bg-stitch-primary text-stitch-on-primary px-5 py-2.5 rounded font-['Geist',sans-serif] text-[15px] leading-[24px] tracking-[-0.005em] font-medium hover:bg-neutral-800 hover:text-white transition-colors" data-path="get-started" to="/register">
<span className="">Create your first form</span>
<MdArrowForward className="text-[18px]" />
</Link>
<Link className="inline-flex items-center gap-[4px] bg-stitch-surface-container-lowest text-stitch-on-surface border border-stitch-outline-variant px-5 py-2.5 rounded font-['Geist',sans-serif] text-[15px] leading-[24px] tracking-[-0.005em] font-medium hover:bg-stitch-surface-container-low transition-colors" to="#landing-overview">
<span className="">See how it works</span>
</Link>
</div>
{/*  Micro-copy  */}
<p className="font-['JetBrains_Mono',monospace] text-[12px] leading-[16px] tracking-[0.02em] text-stitch-secondary mb-0">Create your first form in minutes</p>
</section>
{/*  PRODUCT WORKFLOW (4-Stage Pipeline)  */}
<section id="landing-workflow" className="w-full bg-stitch-surface-container-low border-y border-stitch-outline-variant py-[40px]">
<div className="max-w-[1200px] mx-auto px-[32px]">
<div className="flex flex-col mb-12">
<span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase text-stitch-secondary mb-2">Workflow</span>
<h2 className="font-['Geist',sans-serif] text-[44px] leading-[52px] tracking-[-0.03em] font-medium text-stitch-primary tracking-tight">Everything from creation to insight.</h2>
</div>
<div className="grid grid-cols-1 md:grid-cols-4 gap-[24px]">
{/*  01 CREATE  */}
<div className="bg-stitch-surface-container-lowest p-6 rounded-lg border border-stitch-outline-variant flex flex-col justify-between h-[360px]">
<div>
<div className="flex items-center justify-between mb-4">
<span className="font-['JetBrains_Mono',monospace] text-[12px] text-stitch-primary font-semibold">01 • CREATE</span>
<MdEditNote className="text-stitch-secondary text-[20px]" />
</div>
<h3 className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary mb-2">Build thoughtful forms quickly.</h3>
<p className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant">Build your form with AI-assisted questions, validation, and simple conditional logic.</p>
</div>
<div className="bg-stitch-surface-container-low p-3.5 rounded border border-stitch-outline-variant flex flex-col gap-2">
<div className="flex items-center gap-1.5 text-stitch-secondary font-['JetBrains_Mono',monospace] text-[10px]">
<span className="w-1.5 h-1.5 rounded-full bg-stitch-primary"></span> PROMPT GENERATION
            </div>
<p className="font-['Geist',sans-serif] text-[12px] text-stitch-primary font-medium">&quot;Generate onboarding survey for fintech API&quot;</p>
<div className="px-2 py-1 rounded bg-stitch-surface-container border border-stitch-outline-variant text-stitch-secondary font-['JetBrains_Mono',monospace] text-[11px] flex items-center justify-between">
<span className="">Result: 4 balanced questions</span>
<span className="text-stitch-primary font-semibold">Ready</span>
</div>
</div>
</div>
{/*  02 PUBLISH  */}
<div className="bg-stitch-surface-container-lowest p-6 rounded-lg border border-stitch-outline-variant flex flex-col justify-between h-[360px]">
<div>
<div className="flex items-center justify-between mb-4">
<span className="font-['JetBrains_Mono',monospace] text-[12px] text-stitch-primary font-semibold">02 • PUBLISH</span>
<MdSend className="text-stitch-secondary text-[20px]" />
</div>
<h3 className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary mb-2">Share your form with anyone.</h3>
<p className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant">Share your form with anyone using a public link.</p>
</div>
<div className="bg-stitch-surface-container-low p-3.5 rounded border border-stitch-outline-variant flex flex-col gap-2">
<div className="flex items-center justify-between text-stitch-secondary font-['JetBrains_Mono',monospace] text-[10px]">
<span className="">DISTRIBUTION LINK</span>
<span className="text-stitch-primary font-medium">Public link • Active</span>
</div>
<div className="px-2.5 py-1.5 rounded bg-stitch-surface-container border border-stitch-outline-variant text-stitch-primary font-['JetBrains_Mono',monospace] text-[12px] truncate">
              paperless.so/f/q3-feedback
            </div>
<div className="flex items-center justify-between pt-1">
<span className="text-stitch-secondary font-['JetBrains_Mono',monospace] text-[11px]">Shareable link ready</span>
<button className="px-2 py-0.5 bg-stitch-surface-container-lowest border border-stitch-outline-variant rounded text-[11px] font-medium text-stitch-primary hover:bg-stitch-surface-container">Copy</button>
</div>
</div>
</div>
{/*  03 COLLECT  */}
<div className="bg-stitch-surface-container-lowest p-6 rounded-lg border border-stitch-outline-variant flex flex-col justify-between h-[360px]">
<div>
<div className="flex items-center justify-between mb-4">
<span className="font-['JetBrains_Mono',monospace] text-[12px] text-stitch-primary font-semibold">03 • COLLECT</span>
<MdDataset className="text-stitch-secondary text-[20px]" />
</div>
<h3 className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary mb-2">Receive structured responses.</h3>
<p className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant">
              Lightweight, distraction-free responder view with response validation, pagination, and file uploads.
            </p>
</div>
<div className="bg-stitch-surface-container-low p-3.5 rounded border border-stitch-outline-variant flex flex-col gap-2.5"><div className="flex w-full flex-wrap items-center justify-between gap-2"><span className="text-stitch-secondary font-['JetBrains_Mono',monospace] text-[10px]">STATUS</span><span className="text-stitch-primary font-['JetBrains_Mono',monospace] text-[11px] font-semibold flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-stitch-primary animate-pulse"></span> Active</span></div><div className="flex w-full flex-wrap items-baseline justify-between gap-2"><span className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary font-semibold">Collecting</span><span className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-secondary">Accepting responses</span></div><div className="w-full bg-stitch-surface-container-high h-1.5 rounded-full overflow-hidden"><div className="bg-stitch-primary h-full w-full"></div></div></div>
</div>
{/*  04 UNDERSTAND  */}
<div className="bg-stitch-surface-container-lowest p-6 rounded-lg border border-stitch-outline-variant flex flex-col justify-between h-[360px]">
<div>
<div className="flex items-center justify-between mb-4">
<span className="font-['JetBrains_Mono',monospace] text-[12px] text-stitch-primary font-semibold">04 • UNDERSTAND</span>
<MdPsychology className="text-stitch-secondary text-[20px]" />
</div>
<h3 className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary mb-2">Turn responses into insights.</h3>
<p className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant">AI helps categorize responses, surface useful themes, and summarize what people are saying.</p>
</div>
<div className="bg-stitch-surface-container-low p-3.5 rounded border border-stitch-outline-variant flex flex-col gap-2">
<div className="flex items-center justify-between text-stitch-secondary font-['JetBrains_Mono',monospace] text-[10px]">
<span className="">DOMINANT THEMES</span>
<span className="text-stitch-primary font-medium">3 Detected</span>
</div>
<div className="flex flex-col gap-1.5"><div className="flex items-center justify-between font-['JetBrains_Mono',monospace] text-[11px]"><span className="text-stitch-primary">Docs clarity</span><span className="text-stitch-secondary">High</span></div><div className="w-full bg-stitch-surface-container-high h-1 rounded-full overflow-hidden"><div className="bg-stitch-primary h-full w-[68%]"></div></div><div className="flex items-center justify-between font-['JetBrains_Mono',monospace] text-[11px] pt-1"><span className="text-stitch-primary">Auth friction</span><span className="text-stitch-secondary">Moderate</span></div><div className="w-full bg-stitch-surface-container-high h-1 rounded-full overflow-hidden"><div className="bg-stitch-primary h-full w-[25%]"></div></div></div>
</div>
</div>
</div>
</div>
</section>
{/*  CREATION INTELLIGENCE  */}
<section id="landing-creation" className="w-full max-w-[1200px] mx-auto px-[32px] py-[40px]">
<div className="flex flex-col mb-12">
<span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase text-stitch-secondary mb-2">Creation Intelligence</span>
<h2 className="font-['Geist',sans-serif] text-[44px] leading-[52px] tracking-[-0.03em] font-medium text-stitch-primary tracking-tight mb-3">Build better forms with AI.</h2>
<p className="font-['Geist',sans-serif] text-[18px] leading-[28px] tracking-[-0.01em] text-stitch-on-surface-variant max-w-2xl">
        Paperless helps users create and refine forms without taking control away from them. AI suggestions are clear proposals you can accept or reject.
      </p>
</div>
<div className="grid grid-cols-1 md:grid-cols-3 gap-[24px]">
{/*  Card 1: AI Question Generation  */}
<div className="bg-stitch-surface-container-lowest p-6 rounded-lg border border-stitch-outline-variant flex flex-col justify-between">
<div>
<div className="flex items-center gap-2 mb-3">
<MdAutoFixHigh className="text-stitch-primary text-[20px]" />
<span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase text-stitch-secondary">Generation</span>
</div>
<h3 className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary mb-2">AI Question Generation</h3>
<p className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant mb-6">
            Generate thoughtful questions tailored to your research objectives from a simple prompt.
          </p>
{/*  Proposal UI Container  */}
<div className="p-4 rounded bg-stitch-surface-container-low border border-stitch-outline-variant flex flex-col gap-3">
<div className="text-stitch-secondary font-['JetBrains_Mono',monospace] text-[11px]">
              GOAL: &quot;Measure developer friction during CLI setup&quot;
            </div>
<div className="p-3 bg-stitch-surface-container-lowest border border-stitch-outline-variant rounded flex flex-col gap-2">
<span className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-primary font-medium">Which step in the CLI authentication took longer than expected?</span>
<div className="flex flex-col gap-1.5 pl-2 font-['JetBrains_Mono',monospace] text-[11px] text-stitch-secondary">
<span className="">• Browser OAuth redirect</span>
<span className="">• Token manual pasting</span>
<span className="">• SSH key generation</span>
</div>
</div>
</div>
</div>
<div className="pt-6 flex items-center justify-between">
<div className="flex items-center gap-2">
<button className="px-3 py-1 bg-stitch-primary text-stitch-on-primary rounded text-[13px] leading-[20px] font-medium hover:bg-neutral-800 hover:text-white transition-colors">Accept</button>
<button className="px-3 py-1 bg-stitch-surface-container border border-stitch-outline-variant text-stitch-on-surface-variant hover:bg-stitch-surface-container-highest hover:text-stitch-primary rounded text-[13px] leading-[20px] font-medium transition-colors">Dismiss</button>
</div>
<button className="text-stitch-secondary hover:text-stitch-primary font-['JetBrains_Mono',monospace] text-[12px] leading-[16px] tracking-[0.02em] flex items-center gap-1 transition-colors">
<MdRefresh className="text-[14px]" /> Regenerate
          </button>
</div>
</div>
{/*  Card 2: AI Writing Improvement  */}
<div className="bg-stitch-surface-container-lowest p-6 rounded-lg border border-stitch-outline-variant flex flex-col justify-between">
<div>
<div className="flex items-center gap-2 mb-3">
<MdFormatAlignLeft className="text-stitch-primary text-[20px]" />
<span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase text-stitch-secondary">Refinement</span>
</div>
<h3 className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary mb-2">AI Writing Improvement</h3>
<p className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant mb-6">
            Improve unclear questions and descriptions to enhance respondent engagement and clarity.
          </p>
{/*  Diff UI Container  */}
<div className="p-4 rounded bg-stitch-surface-container-low border border-stitch-outline-variant flex flex-col gap-3">
<div className="flex flex-col gap-1 text-[12px]">
<span className="font-['JetBrains_Mono',monospace] text-[10px] text-stitch-secondary">ORIGINAL DRAFT</span>
<p className="line-through text-stitch-secondary font-['Geist',sans-serif]">Tell us what you didn&apos;t like about the dashboard navigation maybe?</p>
</div>
<div className="flex flex-col gap-1 text-[12px] pt-1">
<span className="font-['JetBrains_Mono',monospace] text-[10px] text-stitch-primary font-semibold">SUGGESTED REVISION</span>
<p className="text-stitch-primary font-['Geist',sans-serif] font-medium">What was the most challenging part of finding items in the navigation?</p>
</div>
<div className="mt-1 px-2.5 py-1 rounded bg-stitch-surface-container border border-stitch-outline-variant text-stitch-primary font-['JetBrains_Mono',monospace] text-[10px] flex items-center gap-1.5">
<MdVerified className="text-[14px]" />
<span className="">Improves clarity and question wording</span>
</div>
</div>
</div>
<div className="pt-6 flex items-center gap-2">
<button className="px-3 py-1 bg-stitch-primary text-stitch-on-primary rounded text-[13px] leading-[20px] font-medium hover:bg-neutral-800 hover:text-white transition-colors">Apply change</button>
<button className="px-3 py-1 bg-stitch-surface-container border border-stitch-outline-variant text-stitch-on-surface-variant hover:bg-stitch-surface-container-highest hover:text-stitch-primary rounded text-[13px] leading-[20px] font-medium transition-colors">Keep original</button>
</div>
</div>
{/*  Card 3: Form Consultant  */}
<div className="bg-stitch-surface-container-lowest p-6 rounded-lg border border-stitch-outline-variant flex flex-col justify-between">
<div>
<div className="flex items-center gap-2 mb-3">
<MdHealthAndSafety className="text-stitch-primary text-[20px]" />
<span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase text-stitch-secondary">Auditing</span>
</div>
<h3 className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary mb-2">Form Consultant</h3>
<p className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant mb-6">
            Get structural recommendations about pacing, layout, and mobile completion bottlenecks.
          </p>
{/*  Audit UI Container  */}
<div className="p-4 rounded bg-stitch-surface-container-low border border-stitch-outline-variant flex flex-col gap-3"><div className="flex items-center justify-between pb-1"><span className="font-['JetBrains_Mono',monospace] text-[10px] text-stitch-secondary">AUDIT SUMMARY</span><span className="font-['JetBrains_Mono',monospace] text-[12px] text-stitch-primary font-semibold">2 recommendations</span></div><div className="p-3 bg-stitch-surface-container-lowest border border-stitch-outline-variant rounded flex flex-col gap-1.5"><div className="flex items-center gap-1.5 text-stitch-primary text-[11px] font-['JetBrains_Mono',monospace] font-medium"><MdWarning className="text-[14px]" /><span className="">Mobile Completion Notice</span></div><p className="font-['Geist',sans-serif] text-[12px] text-stitch-on-surface-variant">Question 2 may cause friction on mobile devices. Consider simplifying.</p><span className="text-stitch-secondary font-['JetBrains_Mono',monospace] text-[10px] pt-1">Recommendation: Shorten question text or split into multiple steps.</span></div></div>
</div>
<div className="pt-6 flex items-center gap-2">
<button className="px-3 py-1 bg-stitch-primary text-stitch-on-primary rounded text-[13px] leading-[20px] font-medium hover:bg-neutral-800 hover:text-white transition-colors">Apply</button>
<button className="px-3 py-1 bg-stitch-surface-container border border-stitch-outline-variant text-stitch-on-surface-variant hover:bg-stitch-surface-container-highest hover:text-stitch-primary rounded text-[13px] leading-[20px] font-medium transition-colors">Review</button>
</div>
</div>
</div>
</section>
{/*  RESPONSE INTELLIGENCE  */}
<section id="landing-response" className="w-full bg-stitch-surface-container-low border-y border-stitch-outline-variant py-[40px]">
<div className="max-w-[1200px] mx-auto px-[32px]">
<div className="flex flex-col mb-12">
<span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase text-stitch-secondary mb-2">Response Intelligence</span>
<h2 className="font-['Geist',sans-serif] text-[44px] leading-[52px] tracking-[-0.03em] font-medium text-stitch-primary tracking-tight mb-3">Your responses are more than a spreadsheet.</h2>
<p className="font-['Geist',sans-serif] text-[18px] leading-[28px] tracking-[-0.01em] text-stitch-on-surface-variant max-w-2xl">AI helps categorize responses, surface useful themes, and summarize what people are saying.</p>
</div>
<div className="grid grid-cols-1 md:grid-cols-12 gap-[24px]">
{/*  Column 1: AI Summary (Live)  */}
<div className="md:col-span-4 bg-stitch-surface-container-lowest p-6 rounded-lg border border-stitch-outline-variant flex flex-col justify-between">
<div>
<div className="flex items-center justify-between mb-4">
<span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase text-stitch-secondary">Synthesis</span>
<span className="flex items-center gap-1 font-['JetBrains_Mono',monospace] text-[11px] text-stitch-primary"><span className="w-1.5 h-1.5 rounded-full bg-stitch-primary"></span> Summary</span>
</div>
<h3 className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary mb-3">Executive Summary</h3>
<div className="p-3.5 bg-stitch-surface-container-low border border-stitch-outline-variant rounded flex flex-col gap-2.5 mb-4">
<span className="font-['JetBrains_Mono',monospace] text-[11px] text-stitch-primary font-semibold">KEY FINDING</span>
<p className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface">
                Respondents highlighted clear onboarding workflows, while several requested additional question types and conditional logic.
              </p>
</div>
<div className="flex flex-col gap-2">
<span className="font-['JetBrains_Mono',monospace] text-[10px] text-stitch-secondary">EXAMPLE INSIGHT</span>
<p className="font-['Geist',sans-serif] text-[12px] italic text-stitch-on-surface-variant pl-2 bg-stitch-surface-container border border-stitch-outline-variant/60 py-1.5 rounded">&quot;AI-generated summaries help surface the main patterns in your responses.&quot;</p>
<span className="font-['JetBrains_Mono',monospace] text-[10px] text-stitch-secondary">Responses analyzed</span>
</div>
</div>
<div className="pt-6">
<button className="w-full py-2 bg-stitch-surface-container hover:bg-stitch-surface-container-highest border border-stitch-outline-variant text-stitch-primary rounded font-['Geist',sans-serif] text-[13px] leading-[20px] font-medium transition-colors">View response insights</button>
</div>
</div>
{/*  Column 2: Theme Extraction  */}
<div className="md:col-span-4 bg-stitch-surface-container-lowest p-6 rounded-lg border border-stitch-outline-variant flex flex-col justify-between">
<div>
<div className="flex items-center justify-between mb-4">
<span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase text-stitch-secondary">Cluster Analysis</span>
<span className="font-['JetBrains_Mono',monospace] text-[11px] text-stitch-secondary">Responses analyzed</span>
</div>
<h3 className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary mb-3">Theme Extraction</h3>
<div className="flex flex-col gap-3"><div className="p-3 rounded bg-stitch-surface-container-low border border-stitch-outline-variant flex flex-col gap-1.5"><div className="flex items-center justify-between"><span className="font-['Geist',sans-serif] text-[13px] leading-[20px] font-medium text-stitch-primary">Documentation Clarity</span><span className="px-2 py-0.5 rounded bg-stitch-surface-container border border-stitch-outline-variant text-[10px] font-['JetBrains_Mono',monospace] uppercase text-stitch-primary">High Volume</span></div><div className="flex items-center justify-between text-stitch-secondary font-['JetBrains_Mono',monospace] text-[11px]"><span className="text-stitch-primary font-medium">Top Theme</span></div><div className="w-full bg-stitch-surface-container h-1 rounded-full overflow-hidden"><div className="bg-stitch-primary h-full w-[89%]"></div></div></div><div className="p-3 rounded bg-stitch-surface-container-low border border-stitch-outline-variant flex flex-col gap-1.5"><div className="flex items-center justify-between"><span className="font-['Geist',sans-serif] text-[13px] leading-[20px] font-medium text-stitch-primary">Question Flow</span><span className="px-2 py-0.5 rounded bg-stitch-surface-container border border-stitch-outline-variant text-[10px] font-['JetBrains_Mono',monospace] uppercase text-stitch-secondary">Feedback</span></div><div className="flex items-center justify-between text-stitch-secondary font-['JetBrains_Mono',monospace] text-[11px]"><span className="text-stitch-secondary font-medium">Moderate</span></div><div className="w-full bg-stitch-surface-container h-1 rounded-full overflow-hidden"><div className="bg-stitch-secondary h-full w-[45%]"></div></div></div><div className="p-3 rounded bg-stitch-surface-container-low border border-stitch-outline-variant flex flex-col gap-1.5"><div className="flex items-center justify-between"><span className="font-['Geist',sans-serif] text-[13px] leading-[20px] font-medium text-stitch-primary">Form Navigation</span><span className="px-2 py-0.5 rounded bg-stitch-surface-container border border-stitch-outline-variant text-[10px] font-['JetBrains_Mono',monospace] uppercase text-stitch-secondary">Feedback</span></div><div className="flex items-center justify-between text-stitch-secondary font-['JetBrains_Mono',monospace] text-[11px]"><span className="text-stitch-secondary font-medium">Steady</span></div><div className="w-full bg-stitch-surface-container h-1 rounded-full overflow-hidden"><div className="bg-stitch-secondary h-full w-[25%]"></div></div></div></div>
</div>
<div className="pt-6">
<button className="w-full py-2 bg-stitch-surface-container hover:bg-stitch-surface-container-highest border border-stitch-outline-variant text-stitch-primary rounded font-['Geist',sans-serif] text-[13px] leading-[20px] font-medium transition-colors">
              View all themes
            </button>
</div>
</div>
{/*  Column 3: Response Categorization  */}
<div className="md:col-span-4 bg-stitch-surface-container-lowest p-6 rounded-lg border border-stitch-outline-variant flex flex-col justify-between">
<div>
<div className="flex items-center justify-between mb-4">
<span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase text-stitch-secondary">Stream</span>
<span className="font-['JetBrains_Mono',monospace] text-[11px] text-stitch-secondary">Categorized</span>
</div>
<h3 className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary mb-3">Response Categorization</h3>
{/*  Filter pills  */}
<div className="flex items-center gap-1.5 mb-4 overflow-x-auto pb-1">
<span className="px-2.5 py-1 rounded bg-stitch-primary text-stitch-on-primary font-['JetBrains_Mono',monospace] text-[11px] whitespace-nowrap cursor-pointer">All</span>
<span className="px-2.5 py-1 rounded bg-stitch-surface-container border border-stitch-outline-variant text-stitch-on-surface-variant font-['JetBrains_Mono',monospace] text-[11px] whitespace-nowrap cursor-pointer hover:bg-neutral-200">Requests</span>
<span className="px-2.5 py-1 rounded bg-stitch-surface-container border border-stitch-outline-variant text-stitch-on-surface-variant font-['JetBrains_Mono',monospace] text-[11px] whitespace-nowrap cursor-pointer hover:bg-neutral-200">Bugs</span>
<span className="px-2.5 py-1 rounded bg-stitch-surface-container border border-stitch-outline-variant text-stitch-on-surface-variant font-['JetBrains_Mono',monospace] text-[11px] whitespace-nowrap cursor-pointer hover:bg-neutral-200">Praise</span>
</div>
{/*  Interactive card list  */}
<div className="flex flex-col gap-2.5">
<div className="p-3 rounded bg-stitch-surface-container-low border border-stitch-outline-variant flex flex-col gap-1.5">
<div className="flex items-center justify-between">
<span className="font-['JetBrains_Mono',monospace] text-[11px] text-stitch-primary font-semibold">EXAMPLE RESPONSE</span>
<span className="px-2 py-0.5 rounded bg-stitch-surface-container border border-stitch-outline-variant text-[10px] font-['JetBrains_Mono',monospace] uppercase text-stitch-primary">Feature Request</span>
</div>
<p className="font-['Geist',sans-serif] text-[12px] text-stitch-on-surface">&quot;Would love additional question types like date pickers and file attachments.&quot;</p>
</div>
<div className="p-3 rounded bg-stitch-surface-container-low border border-stitch-outline-variant flex flex-col gap-1.5">
<div className="flex items-center justify-between">
<span className="font-['JetBrains_Mono',monospace] text-[11px] text-stitch-primary font-semibold">EXAMPLE RESPONSE</span>
<span className="px-2 py-0.5 rounded bg-stitch-surface-container border border-stitch-outline-variant text-[10px] font-['JetBrains_Mono',monospace] uppercase text-stitch-primary">Praise</span>
</div>
<p className="font-['Geist',sans-serif] text-[12px] text-stitch-on-surface">&quot;The respondent experience is lightweight and distraction-free.&quot;</p>
</div>
</div>
</div>
<div className="pt-6">
<button className="w-full py-2 bg-stitch-surface-container hover:bg-stitch-surface-container-highest border border-stitch-outline-variant text-stitch-primary rounded font-['Geist',sans-serif] text-[13px] leading-[20px] font-medium transition-colors">Filter categorized responses</button>
</div>
</div>
</div>
</div>
</section>
{/*  HOW IT WORKS (Minimal horizontal 4-step row)  */}
<section id="landing-overview" className="w-full max-w-[1200px] mx-auto px-[32px] py-[40px]">
<div className="flex flex-col mb-12">
<span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase text-stitch-secondary mb-2">Overview</span>
<h2 className="font-['Geist',sans-serif] text-[44px] leading-[52px] tracking-[-0.03em] font-medium text-stitch-primary tracking-tight">How it works</h2>
</div>
<div className="grid grid-cols-1 md:grid-cols-4 gap-[24px]">
{/*  Step 01  */}
<div className="flex flex-col p-6 rounded-lg bg-stitch-surface-container-low border border-stitch-outline-variant">
<span className="font-['JetBrains_Mono',monospace] text-[13px] text-stitch-primary font-semibold mb-4">01</span>
<h3 className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary mb-2">Create</h3>
<p className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant">Build your form with AI-assisted questions, validation, and simple conditional logic.</p>
</div>
{/*  Step 02  */}
<div className="flex flex-col p-6 rounded-lg bg-stitch-surface-container-low border border-stitch-outline-variant">
<span className="font-['JetBrains_Mono',monospace] text-[13px] text-stitch-primary font-semibold mb-4">02</span>
<h3 className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary mb-2">Publish</h3>
<p className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant">
          Share anywhere via instant public link ready to distribute across any channel.
        </p>
</div>
{/*  Step 03  */}
<div className="flex flex-col p-6 rounded-lg bg-stitch-surface-container-low border border-stitch-outline-variant">
<span className="font-['JetBrains_Mono',monospace] text-[13px] text-stitch-primary font-semibold mb-4">03</span>
<h3 className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary mb-2">Collect</h3>
<p className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant">
          Receive structured, validated responses on lightweight, distraction-free canvases.
        </p>
</div>
{/*  Step 04  */}
<div className="flex flex-col p-6 rounded-lg bg-stitch-surface-container-low border border-stitch-outline-variant">
<span className="font-['JetBrains_Mono',monospace] text-[13px] text-stitch-primary font-semibold mb-4">04</span>
<h3 className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary mb-2">Understand</h3>
<p className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant">AI helps categorize responses, surface useful themes, and summarize what people are saying.</p>
</div>
</div>
</section>
{/*  FINAL CTA BANNER  */}
<section className="w-full max-w-[1200px] mx-auto px-[32px] pb-[40px]">
<div className="bg-white dark:bg-[#09090b] rounded-xl p-12 md:p-16 flex flex-col items-center text-center">
<div className="inline-flex items-center gap-2 px-3 py-1 rounded bg-[#f4f4f5] dark:bg-[#18181b] border border-[#e4e4e7] dark:border-[#27272a] mb-6">
<span className="w-1.5 h-1.5 rounded-full bg-[#FF3B30] animate-pulse motion-reduce:animate-none" aria-hidden="true"></span>
<span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase tracking-wider text-[#71717a] dark:text-[#a1a1aa]">Get Started Today</span>
</div>
<h2 className="font-['Geist',sans-serif] text-[44px] leading-[52px] tracking-[-0.03em] font-medium text-[#09090b] dark:text-white tracking-tight mb-4 max-w-xl">
        Ready to build your next form?
      </h2>
<p className="font-['Geist',sans-serif] text-[18px] leading-[28px] tracking-[-0.01em] text-[#52525b] dark:text-[#a1a1aa] max-w-lg mb-8">
        Join researchers, founders, and product teams building thoughtful forms and uncovering instant insights.
      </p>
<div className="flex items-center gap-[8px] mb-4">
<Link className="inline-flex items-center gap-[4px] bg-[#09090b] dark:bg-white text-white dark:text-[#09090b] px-6 py-3 rounded font-['Geist',sans-serif] text-[15px] leading-[24px] tracking-[-0.005em] font-medium hover:bg-[#262626] dark:hover:bg-[#f4f4f5] hover:text-white dark:hover:text-[#09090b] transition-colors" data-path="get-started" to="/register">
<span className="">Get started for free</span>
<MdArrowForward className="text-[18px]" />
</Link>
</div>
</div>
</section>
</div>
      <footer id="landing-footer" className="w-full bg-stitch-surface-container-lowest border-t border-stitch-outline-variant">
        <div className="max-w-[1200px] mx-auto px-[32px] pt-[48px] pb-[32px]">
          <div className="grid grid-cols-2 md:flex md:flex-row md:items-start md:justify-between gap-[40px] mb-[48px]">
            {/* Brand Block */}
            <div className="col-span-2 md:col-auto flex flex-col items-start gap-[12px]">
              <div className="flex items-center gap-[8px]">

                <span className="font-['Geist',sans-serif] text-[18px] tracking-tight font-medium text-stitch-primary">Paperless</span>
              </div>
              <p className="font-['Geist',sans-serif] text-[14px] leading-[22px] text-stitch-on-surface-variant">Create. Collect. Understand.</p>
            </div>

            {/* Product */}
            <div className="flex flex-col items-start gap-[16px]">
              <span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase text-stitch-secondary">Product</span>
              <div className="flex flex-col items-start gap-[10px]">
                <Link className="font-['Geist',sans-serif] text-[14px] leading-[20px] text-stitch-on-surface hover:text-stitch-primary transition-colors" data-path="product" to="#">Form Builder</Link>
                <Link className="font-['Geist',sans-serif] text-[14px] leading-[20px] text-stitch-on-surface hover:text-stitch-primary transition-colors" data-path="workflow" to="#">Responses</Link>
              </div>
            </div>

            {/* Resources */}
            <div className="flex flex-col items-start gap-[16px]">
              <span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase text-stitch-secondary">Resources</span>
              <div className="flex flex-col items-start gap-[10px]">
                <Link className="font-['Geist',sans-serif] text-[14px] leading-[20px] text-stitch-on-surface hover:text-stitch-primary transition-colors" data-path="documentation" to="#">Documentation</Link>
              </div>
            </div>

            {/* Legal */}
            <div className="flex flex-col items-start gap-[16px]">
              <span className="font-['JetBrains_Mono',monospace] text-[11px] leading-[14px] tracking-[0.08em] font-medium uppercase text-stitch-secondary">Legal</span>
              <div className="flex flex-col items-start gap-[10px]">
                <Link className="font-['Geist',sans-serif] text-[14px] leading-[20px] text-stitch-on-surface hover:text-stitch-primary transition-colors" data-path="privacy" to="#">Privacy</Link>
                <Link className="font-['Geist',sans-serif] text-[14px] leading-[20px] text-stitch-on-surface hover:text-stitch-primary transition-colors" data-path="terms" to="#">Terms</Link>
              </div>
            </div>
          </div>

          {/* Bottom Row */}
          <div className="pt-[24px] border-t border-stitch-outline-variant flex items-center justify-center w-full">
            <p className="font-['JetBrains_Mono',monospace] text-[12px] leading-[16px] text-stitch-secondary text-center">© 2026 Paperless. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Home;
