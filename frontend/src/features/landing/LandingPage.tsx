import React, { useEffect, useRef, useState, useMemo } from 'react';
import './landing.css';

interface LandingPageProps {
  onLogin: () => void;
}

const CLIENTS = [
  { name: 'ICICI Bank', color: '#C2410C' },
  { name: 'Airtel', color: '#B91C1C' },
  { name: 'Asian Paints Ltd', color: '#B91C1C' },
  { name: 'Schindler India', color: '#B91C1C' },
  { name: 'Schwing Stetter', color: '#B91C1C' },
  { name: 'Jindal Worldwide Ltd', color: '#1D4ED8' },
  { name: 'Transsion', color: '#0369A1' },
  { name: 'Indigo Paints', color: '#4338CA' },
  { name: 'Infobahn', color: '#0F766E' },
  { name: 'Thermax', color: '#0369A1' },
  { name: 'Zydus Wellness', color: '#15803D' },
  { name: 'SPG Finserv', color: '#7E22CE' },
  { name: 'Sakthi Finance', color: '#B91C1C' },
  { name: 'Carraro', color: '#315D4B' },
  { name: 'Sumeet Facilities', color: '#315D4B' },
];

const MOMENTS = [
  'A borrower gets a clear answer, in her own language, the first time she asks.',
  'A patient is reminded before she has to chase anyone.',
  'A dealer’s question is settled before it becomes a delay.',
  'A decision arrives with its reasons attached.',
  'A student’s enquiry is answered at midnight, and remembered at noon.',
];

const MANIFESTO_TEXT = 'Enterprises do not run on software alone. They run on moments: a call answered, a document understood, a decision explained, a promise kept.';
const CURRENT_YEAR = new Date().getFullYear();

export const LandingPage: React.FC<LandingPageProps> = ({ onLogin }) => {
  const [scrolled, setScrolled] = useState(false);
  const [headlineActive, setHeadlineActive] = useState(false);
  const [activeMoment, setActiveMoment] = useState(0);
  const [litWordCount, setLitWordCount] = useState(0);

  const manifestoRef = useRef<HTMLParagraphElement>(null);
  const stepsRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const manifestoWords = useMemo(() => MANIFESTO_TEXT.trim().split(/\s+/), []);

  // Set landing page title and body class
  useEffect(() => {
    const prevTitle = document.title;
    document.title = 'Curo AI | AI for human outcomes. The operating system for enterprise care.';
    document.body.classList.add('is-landing');
    document.documentElement.classList.add('is-landing');

    return () => {
      document.title = prevTitle;
      document.body.classList.remove('is-landing');
      document.documentElement.classList.remove('is-landing');
    };
  }, []);

  // Header scroll detection (match scrollY > 20)
  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Headline animation (after 60ms add "go" class)
  useEffect(() => {
    const timer = setTimeout(() => setHeadlineActive(true), 60);
    return () => clearTimeout(timer);
  }, []);

  // Moments rotation (3800ms)
  useEffect(() => {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return;

    const interval = setInterval(() => {
      setActiveMoment((prev) => (prev + 1) % MOMENTS.length);
    }, 3800);
    return () => clearInterval(interval);
  }, []);

  // Manifesto word light-up on scroll
  useEffect(() => {
    const handleManifestoScroll = () => {
      if (!manifestoRef.current) return;
      const r = manifestoRef.current.getBoundingClientRect();
      const p = (window.innerHeight * 0.78 - r.top) / (r.height + window.innerHeight * 0.25);
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReducedMotion) {
        setLitWordCount(manifestoWords.length);
        return;
      }
      const count = Math.max(0, Math.min(manifestoWords.length, Math.round(p * manifestoWords.length)));
      setLitWordCount(count);
    };

    window.addEventListener('scroll', handleManifestoScroll, { passive: true });
    handleManifestoScroll();
    return () => window.removeEventListener('scroll', handleManifestoScroll);
  }, [manifestoWords.length]);

  // Reveal stagger and Steps line animation
  useEffect(() => {
    if (!containerRef.current) return;
    const elements = containerRef.current.querySelectorAll('.rv');

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -6% 0px' }
    );

    elements.forEach((el) => {
      const parent = el.parentNode;
      if (parent) {
        const idx = Array.prototype.indexOf.call(parent.children, el);
        (el as HTMLElement).style.transitionDelay = `${(idx % 4) * 90}ms`;
      }
      observer.observe(el);
    });

    // Steps line animation
    let stepsObserver: IntersectionObserver | null = null;
    if (stepsRef.current) {
      stepsObserver = new IntersectionObserver(
        (entries, obs) => {
          if (entries[0].isIntersecting) {
            stepsRef.current?.classList.add('in');
            obs.disconnect();
          }
        },
        { threshold: 0.3 }
      );
      stepsObserver.observe(stepsRef.current);
    }

    return () => {
      observer.disconnect();
      stepsObserver?.disconnect();
    };
  }, []);

  // Card pointer spotlight
  const handleCardPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const card = e.currentTarget;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    card.style.setProperty('--my', `${e.clientY - rect.top}px`);
  };

  // Constellation Canvas Animation
  useEffect(() => {
    const cv = canvasRef.current;
    const hero = heroRef.current;
    if (!cv || !hero) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ctx = cv.getContext('2d');
    if (prefersReducedMotion || !ctx) return;

    let width = 0;
    let height = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let run = true;
    let animationFrameId: number;

    interface Node {
      x: number;
      y: number;
      vx: number;
      vy: number;
      r: number;
    }

    interface Pulse {
      a: Node;
      b: Node;
      t: number;
    }

    let nodes: Node[] = [];
    let pulses: Pulse[] = [];
    let mouseX = -999;
    let mouseY = -999;
    let tm = 0;
    const maxDist = 135;

    const size = () => {
      if (!cv) return;
      width = cv.clientWidth;
      height = cv.clientHeight;
      cv.width = width * dpr;
      cv.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = width < 700 ? 26 : 62;
      nodes = [];
      for (let i = 0; i < count; i++) {
        nodes.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.25,
          vy: (Math.random() - 0.5) * 0.25,
          r: 1 + Math.random() * 1.6,
        });
      }
    };

    size();
    window.addEventListener('resize', size);

    const onPointerMove = (e: PointerEvent) => {
      const rect = hero.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;
    };

    const onPointerLeave = () => {
      mouseX = -999;
      mouseY = -999;
    };

    hero.addEventListener('pointermove', onPointerMove);
    hero.addEventListener('pointerleave', onPointerLeave);

    const heroObserver = new IntersectionObserver((entries) => {
      run = entries[0].isIntersecting;
      if (run) draw();
    });
    heroObserver.observe(hero);

    const draw = () => {
      if (!run) return;
      ctx.clearRect(0, 0, width, height);
      tm++;

      // Update positions
      nodes.forEach((a) => {
        a.x += a.vx;
        a.y += a.vy;
        if (a.x < 0 || a.x > width) a.vx *= -1;
        if (a.y < 0 || a.y > height) a.vy *= -1;
      });

      // Find pairs & draw lines
      const pairs: [Node, Node][] = [];
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < maxDist) {
            pairs.push([a, b]);
            ctx.strokeStyle = `rgba(156,195,169,${0.2 * (1 - d / maxDist)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }

        // Mouse connection line
        const dm = Math.hypot(nodes[i].x - mouseX, nodes[i].y - mouseY);
        if (dm < 170) {
          ctx.strokeStyle = `rgba(200,173,126,${0.45 * (1 - dm / 170)})`;
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(mouseX, mouseY);
          ctx.stroke();
        }
      }

      // Generate pulses along edges
      if (tm % 50 === 0 && pairs.length && pulses.length < 8) {
        const q = pairs[Math.floor(Math.random() * pairs.length)];
        pulses.push({ a: q[0], b: q[1], t: 0 });
      }

      // Draw pulses
      pulses = pulses.filter((p) => {
        p.t += 0.018;
        if (p.t >= 1) return false;
        const px = p.a.x + (p.b.x - p.a.x) * p.t;
        const py = p.a.y + (p.b.y - p.a.y) * p.t;
        ctx.fillStyle = `rgba(200,173,126,${1 - Math.abs(p.t - 0.5) * 1.2})`;
        ctx.beginPath();
        ctx.arc(px, py, 2.6, 0, 6.3);
        ctx.fill();

        ctx.fillStyle = 'rgba(200,173,126,0.12)';
        ctx.beginPath();
        ctx.arc(px, py, 9, 0, 6.3);
        ctx.fill();
        return true;
      });

      // Draw nodes
      ctx.fillStyle = 'rgba(214,230,218,0.7)';
      nodes.forEach((a) => {
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r, 0, 6.3);
        ctx.fill();
      });

      animationFrameId = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      window.removeEventListener('resize', size);
      hero.removeEventListener('pointermove', onPointerMove);
      hero.removeEventListener('pointerleave', onPointerLeave);
      heroObserver.disconnect();
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <div className="curo-landing" ref={containerRef}>
      {/* Fixed Sticky Header */}
      <header className={scrolled ? 'sc' : ''}>
        <div className="wrap">
          <nav aria-label="Main">
            <a className="logo" href="#top" aria-label="Curo home">
              <i aria-hidden="true" />
              Curo
            </a>
            <ul>
              <li><a href="#care">How care works</a></li>
              <li><a href="#outcomes">Outcomes</a></li>
              <li><a href="#industries">Industries</a></li>
              <li><a href="#trust">Trust</a></li>
            </ul>
            <button type="button" className="btn light" onClick={onLogin}>
              Login
            </button>
          </nav>
        </div>
      </header>

      <main id="top">
        {/* Hero Section */}
        <section className="hero" id="hero" ref={heroRef}>
          <canvas id="net" ref={canvasRef} aria-hidden="true" />
          <div className="wrap hero-grid">
            <div>
              <span className="kick">The operating system for enterprise care</span>
              <h1 id="h1" className={headlineActive ? 'go' : ''} aria-label="AI for human outcomes.">
                <span className="w"><i style={{ '--n': 0 } as React.CSSProperties}>AI</i></span>{' '}
                <span className="w"><i style={{ '--n': 1 } as React.CSSProperties}>for</i></span>{' '}
                <span className="w"><i style={{ '--n': 2 } as React.CSSProperties}>human</i></span>{' '}
                <em>
                  <span className="w"><i style={{ '--n': 3 } as React.CSSProperties}>outcomes.</i></span>
                </em>
              </h1>
              <p className="sub">
                Curo deploys AI that listens, understands and follows through, so every customer, patient, student and partner is looked after at the scale your enterprise runs.
              </p>
              <div className="cta">
                <a className="btn light" href="#care">See how care scales</a>
                <button type="button" className="btn line" onClick={onLogin}>
                  Login
                </button>
              </div>
            </div>

            <div className="moments">
              <small><b />Moments Curo is built for</small>
              <div className="mom" id="mom">
                {MOMENTS.map((moment, idx) => (
                  <p key={idx} className={activeMoment === idx ? 'on' : ''}>
                    {moment}
                  </p>
                ))}
              </div>
            </div>
          </div>
          <span className="scroll" aria-hidden="true" />
        </section>

        {/* Manifesto Section */}
        <section className="manifesto">
          <div className="wrap">
            <p id="mf" ref={manifestoRef} aria-label={MANIFESTO_TEXT}>
              {manifestoWords.map((word, idx) => (
                <React.Fragment key={idx}>
                  <span className={`mw ${idx < litWordCount ? 'lit' : ''}`} aria-hidden="true">
                    {word}
                  </span>{' '}
                </React.Fragment>
              ))}
            </p>
            <p className="rv">
              Curo is the layer that makes every one of those moments feel cared for, whether you serve a hundred people or a hundred million. Technology is how we deliver it. The outcome for the person on the other side is why.
            </p>
          </div>
        </section>

        {/* How Enterprise Care Works Section */}
        <section className="dark" id="care">
          <div className="wrap">
            <span className="kick rv">How enterprise care works</span>
            <h2 className="rv" style={{ marginTop: 14 }}>One system that cares from first hello to final outcome.</h2>
            <p className="lead rv">
              Curo sits across your channels, teams and systems, so care no longer depends on who picked up, which queue it landed in or what language was spoken.
            </p>
            <div className="steps" id="steps" ref={stepsRef}>
              <div className="step rv">
                <span>01</span>
                <h3>Listen</h3>
                <p>Every conversation, form and signal is heard across channels and languages, not just logged.</p>
              </div>
              <div className="step rv">
                <span>02</span>
                <h3>Understand</h3>
                <p>Context is built across your systems, so nobody is asked to repeat themselves.</p>
              </div>
              <div className="step rv">
                <span>03</span>
                <h3>Decide</h3>
                <p>Your policies are applied consistently, with reasons a person can read, question and override.</p>
              </div>
              <div className="step rv">
                <span>04</span>
                <h3>Follow through</h3>
                <p>Work is carried to completion, and people step in at the moments that matter most.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Outcomes Section */}
        <section id="outcomes">
          <div className="wrap">
            <span className="kick rv">Outcomes</span>
            <h2 className="rv" style={{ marginTop: 14 }}>Measured in outcomes people can feel.</h2>
            <div className="out">
              <article className="card rv" onPointerMove={handleCardPointerMove}>
                <svg viewBox="0 0 32 32" aria-hidden="true">
                  <circle cx="16" cy="16" r="11" />
                  <path d="M16 9v7l5 3" />
                </svg>
                <h3>People answered, not queued</h3>
                <p>Questions are resolved in the moment, at any hour, without hold music or handoffs.</p>
              </article>

              <article className="card rv" onPointerMove={handleCardPointerMove}>
                <svg viewBox="0 0 32 32" aria-hidden="true">
                  <path d="M5 8h22M5 16h14M5 24h9" />
                  <path d="M23 19l3 3 4-5" />
                </svg>
                <h3>Decisions with reasons</h3>
                <p>Every outcome carries a clear explanation and an audit trail your teams and regulators can follow.</p>
              </article>

              <article className="card rv" onPointerMove={handleCardPointerMove}>
                <svg viewBox="0 0 32 32" aria-hidden="true">
                  <circle cx="16" cy="16" r="11" />
                  <path d="M5 16h22M16 5c-5 6-5 16 0 22M16 5c5 6 5 16 0 22" />
                </svg>
                <h3>Every language, the same care</h3>
                <p>People are met in the language they think in, with the same quality in each one.</p>
              </article>

              <article className="card rv" onPointerMove={handleCardPointerMove}>
                <svg viewBox="0 0 32 32" aria-hidden="true">
                  <circle cx="11" cy="11" r="4" />
                  <circle cx="23" cy="13" r="3" />
                  <path d="M4 26c0-5 3-8 7-8s7 3 7 8M20 26c0-3 1.5-5 4-5s4 2 4 5" />
                </svg>
                <h3>Humans where it counts</h3>
                <p>Routine work is carried by AI so your people can give their time to the conversations that need them.</p>
              </article>
            </div>
          </div>
        </section>

        {/* Industries Section */}
        <section className="ind" id="industries">
          <div className="wrap">
            <span className="kick rv">Industries</span>
            <h2 className="rv" style={{ marginTop: 14 }}>Care looks different in every industry.</h2>
            <div className="ig">
              <article className="card rv" onPointerMove={handleCardPointerMove}>
                <h3>BFSI</h3>
                <p>Borrowers understood, applications moving and every decision explained.</p>
              </article>
              <article className="card rv" onPointerMove={handleCardPointerMove}>
                <h3>Manufacturing</h3>
                <p>Dealers, plants and suppliers kept in step, with fewer delays between them.</p>
              </article>
              <article className="card rv" onPointerMove={handleCardPointerMove}>
                <h3>Healthcare &amp; Hospitals</h3>
                <p>Patients followed up with, not forgotten, and clinicians freed from paperwork.</p>
              </article>
              <article className="card rv" onPointerMove={handleCardPointerMove}>
                <h3>Telecom</h3>
                <p>Customers welcomed, supported and retained across millions of conversations.</p>
              </article>
              <article className="card rv" onPointerMove={handleCardPointerMove}>
                <h3>Education</h3>
                <p>Every enquiry answered and every family guided from interest to admission.</p>
              </article>
              <article className="card rv" onPointerMove={handleCardPointerMove}>
                <h3>Large Enterprises</h3>
                <p>Teams released from repetitive work to do what only people can do.</p>
              </article>
            </div>
          </div>
        </section>

        {/* Clients Marquee Section */}
        <section className="clients" aria-label="Clients">
          <div className="wrap">
            <span className="kick">Trusted by enterprises that take care seriously</span>
          </div>
          <div className="marquee">
            <div className="track" id="track" role="list">
              {[...CLIENTS, ...CLIENTS, ...CLIENTS].map((client, idx) => (
                <span
                  key={idx}
                  className="lg"
                  role={idx < CLIENTS.length ? 'listitem' : undefined}
                  aria-hidden={idx >= CLIENTS.length ? 'true' : undefined}
                  style={{ '--c': client.color } as React.CSSProperties}
                >
                  {client.name}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* Trust Section */}
        <section className="dark" id="trust">
          <div className="wrap tr">
            <div>
              <span className="kick rv">Trust</span>
              <h2 className="rv" style={{ marginTop: 14 }}>Care needs guardrails.</h2>
              <p className="lead rv">
                Curo runs in the cloud, on-premises or in a hybrid setup, so sensitive customer data can stay inside your environment.
              </p>
            </div>
            <div>
              <div className="ti rv">
                <h3>Built in-house</h3>
                <p>We build the AI and ML ourselves, so it can be tuned to your policies, languages and the way your people speak.</p>
              </div>
              <div className="ti rv">
                <h3>Fits what you already run</h3>
                <p>Curo connects to your existing systems and telephony through APIs, without asking you to replace what works.</p>
              </div>
              <div className="ti rv">
                <h3>Accountable by design</h3>
                <p>Conversations, extracted information and decisions are logged and reviewable by your risk and compliance teams.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Contact Section */}
        <section className="contact" id="contact">
          <div className="wrap cg">
            <div className="rv">
              <span className="kick" style={{ color: 'var(--gold)' }}>Talk to us</span>
              <h2 style={{ marginTop: 14 }}>Let’s design care for your enterprise.</h2>
              <p className="lead" style={{ color: '#9FB0A5' }}>
                Tell us who you want to take better care of. We’ll come back with a working demo built around your own conversations and documents.
              </p>
              <ul className="cl">
                <li>
                  <small>Email</small>
                  <a href="mailto:mayank@curoai.in">mayank@curoai.in</a>
                </li>
                <li>
                  <small>Phone</small>
                  <a href="tel:+917412034540">74120 34540</a>
                </li>
              </ul>
            </div>

            <form className="rv" action="mailto:mayank@curoai.in" method="post" encType="text/plain">
              <label>
                Name
                <input name="name" required autoComplete="name" placeholder="Your name" />
              </label>
              <label>
                Work email
                <input name="email" type="email" required autoComplete="email" placeholder="you@company.com" />
              </label>
              <label>
                Company
                <input name="company" autoComplete="organization" placeholder="Company name" />
              </label>
              <label>
                Industry
                <select name="industry" defaultValue="">
                  <option value="">Choose an industry</option>
                  <option>BFSI</option>
                  <option>Manufacturing</option>
                  <option>Healthcare &amp; Hospitals</option>
                  <option>Telecom</option>
                  <option>Education</option>
                  <option>Large Enterprise</option>
                  <option>Other</option>
                </select>
              </label>
              <label>
                Who do you want to take better care of?
                <textarea name="message" placeholder="Tell us about the people and the process" />
              </label>
              <button className="btn light" type="submit">
                Start the conversation
              </button>
              <p className="note">Submitting opens your email app to send your enquiry to Curo.</p>
            </form>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer>
        <div className="wrap">
          <span>&copy; <span id="yr">{CURRENT_YEAR}</span> Curo AI. All rights reserved.</span>
          <span>
            <a href="mailto:mayank@curoai.in">mayank@curoai.in</a>
            <a href="tel:+917412034540">74120 34540</a>
          </span>
        </div>
      </footer>
    </div>
  );
};
