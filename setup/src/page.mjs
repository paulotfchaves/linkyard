// The page: one route, one card, three states.
//
// It is not a landing page. Whoever reads it has already decided to install, so
// there is no hero, no benefit section, no repeated call to action — the page
// exists to get out of the way of the installation.
//
// All copy lives here, in two dictionaries with identical key sets, and every
// string the browser displays comes from one of them. The client script renders
// only text the server sent it: an upstream error message must never find a path
// onto this page, and the shortest way to guarantee that is to give the client
// no strings of its own.

import { FAILURE } from './secret.mjs'
import { COST, PHASES } from './provision.mjs'

export const en = {
  'meta.title': 'Install Linkyard',
  'meta.description': 'Set up Linkyard in your own Railway account and on your own domain.',

  'brand.name': 'Linkyard',
  'page.title': 'Install',
  'page.title.script': 'Linkyard',
  'page.lede':
    'This creates the three services in your own Railway account, on your own domain, and hands the panel back to you with your account already made.',

  'notice.cost': `Three services on Railway cost about US$ ${COST.minUsd.toFixed(2)} to ${COST.maxUsd.toFixed(2)} a month. The US$ ${COST.hobbyPlanUsd.toFixed(2)} Hobby plan does not cover it.`,
  'notice.storage': 'We keep your email address and the date. Nothing else — the code that stores it is open.',
  'notice.storage.link': 'Read the Worker',
  'notice.address': 'Linkyard only ever asks for a token at this address.',

  'section.install': 'Your installation',
  'section.credentials': 'Your credentials',
  'section.credentials.lede':
    'These two are the last thing we ask for, and the first thing we get rid of. Neither is written to a database, a log, or a file.',

  'field.email.label': 'Email',
  'field.email.hint': 'You sign in to the panel with this.',
  'field.password.label': 'Panel password',
  'field.password.hint': 'At least 12 characters. Your account is created during the install, so no setup page is ever left open.',
  'field.apex.label': 'Domain',
  'field.apex.hint': 'The domain as it appears in Cloudflare.',
  'field.panelHost.label': 'Panel subdomain',
  'field.panelHost.hint': 'Where you will manage links.',
  'field.redirectHost.label': 'Redirect subdomain',
  'field.redirectHost.hint': 'Where your short links live. Optional — you can add it later.',
  'field.locale.label': 'Panel language',
  'field.timezone.label': 'Time zone',
  'field.cloudflareToken.label': 'Cloudflare token',
  'field.cloudflareToken.hint': 'Scope it to this one zone and set the TTL to one day. It expires on its own — we cannot delete it without asking for more power than this job needs.',
  'field.railwayToken.label': 'Railway token',
  'field.railwayToken.hint': 'Create a new token that is used nowhere else. We delete it automatically when the installation finishes, whether it succeeds or fails.',

  'guide.railway.title': 'How to create the Railway token',
  'guide.railway.step1': 'Open railway.com/account/tokens.',
  'guide.railway.step2': 'Name it linkyard-install so you recognise it if anything goes wrong.',
  'guide.railway.step3': 'Choose your account, not a project — a project token cannot create a project.',
  'guide.railway.step4': 'Copy it once and paste it here. You will not need it again.',

  'guide.cloudflare.title': 'How to create the Cloudflare token',
  'guide.cloudflare.step1': 'Open dash.cloudflare.com/profile/api-tokens and start from Edit zone DNS.',
  'guide.cloudflare.step2': 'Permissions: Zone · DNS · Edit, plus Zone · Zone · Read.',
  'guide.cloudflare.step3': 'Zone Resources: Include · Specific zone · your domain. Not "All zones" — we refuse a token that can see more than one.',
  'guide.cloudflare.step4': 'TTL: set the end date to tomorrow. This is what ends the token, because deleting it would need a larger permission.',
  'guide.cloudflare.step5': 'Create, copy, paste here.',

  'action.verify': 'Check my credentials',
  'action.verifying': 'Checking…',
  'action.confirm': 'Create these resources',
  'action.back': 'Change something',
  'action.open': 'Open my panel',

  'confirm.title': 'Before anything is created',
  'confirm.account': 'Railway account',
  'confirm.zone': 'Cloudflare zone',
  'confirm.cost': 'Estimated cost',
  'confirm.cost.value': `US$ ${COST.minUsd.toFixed(2)}–${COST.maxUsd.toFixed(2)} per month, billed to you by Railway`,
  'confirm.records': 'Records we will create',
  'confirm.records.note': 'Create-only. If any of these names already exists, the install stops instead of overwriting it.',
  'confirm.workspaces': 'This token can reach more than one workspace. We will use the first.',

  'progress.title': 'Installing',
  'progress.events': 'Created so far',

  'phase.verify': 'Checking your credentials',
  'phase.infra': 'Creating your panel',
  'phase.domain': 'Claiming your address',
  'phase.dns': 'Configuring the address',
  'phase.certificate': 'Waiting for the certificate',
  'phase.admin': 'Creating your account',
  'phase.cleanup': 'Deleting your token',

  'event.resource.railway-project': 'Railway project',
  'event.resource.railway-service': 'Service',
  'event.resource.railway-volume': 'Volume',
  'event.resource.railway-service-domain': 'Internal address',
  'event.resource.railway-custom-domain': 'Custom domain',
  'event.resource.dns-record': 'DNS record',
  'event.dns.plan': 'About to write:',
  'event.dns.visible': 'Visible to public DNS:',
  'event.certificate.issued': 'Certificate issued for',

  'done.title': 'Your panel is up',
  'done.body': 'Sign in with the email and password you chose.',
  'done.redirect': 'Your short links will answer at',
  'done.token.deleted': 'Your Railway token was deleted and we confirmed it no longer works.',
  'done.token.unconfirmed': 'We asked Railway to delete your token but could not confirm it. Delete it by hand at railway.com/account/tokens.',

  'failed.title': 'The installation stopped',
  'failed.body': 'Everything this job created has been removed, and your Railway token was deleted.',

  'manual.title': 'Some things could not be removed',
  'manual.body': 'The installation stopped and the cleanup did not finish. These exist in your account and need to be removed by hand:',

  'lang.switch': 'Português',
  'footer.repo': 'Source code',
  'footer.license': 'MIT',

  'challenge.title': 'One check first',
  'challenge.body':
    'The next page is where you paste your tokens, and it loads nothing from anyone else — not a font, not a script. So the check happens here instead.',
  'challenge.submit': 'Continue',

  [`error.${FAILURE.INPUT_INVALID}`]: 'Something in the form is not valid. Check the highlighted field.',
  [`error.${FAILURE.TURNSTILE_FAILED}`]: 'The check did not pass. Reload the page and try again.',
  [`error.${FAILURE.TOO_MANY_JOBS}`]: 'Too many installations are running right now. Try again in a few minutes.',
  [`error.${FAILURE.JOB_NOT_FOUND}`]: 'This installation is no longer open. Start again.',
  [`error.${FAILURE.RAILWAY_TOKEN_INVALID}`]: 'Railway did not accept that token.',
  [`error.${FAILURE.RAILWAY_TOKEN_NOT_ACCOUNT}`]: 'That is a project token. Create an account token at railway.com/account/tokens.',
  [`error.${FAILURE.RAILWAY_TOKEN_NOT_FOUND}`]: 'We could not find that token to delete it. Delete it by hand at railway.com/account/tokens.',
  [`error.${FAILURE.RAILWAY_TOKEN_AMBIGUOUS}`]: 'Two of your tokens look alike, so we did not delete either. Delete this one by hand.',
  [`error.${FAILURE.RAILWAY_WORKSPACE_MISSING}`]: 'That token cannot reach any workspace.',
  [`error.${FAILURE.RAILWAY_RATE_LIMITED}`]: 'Railway is rate limiting this account. Try again in a few minutes.',
  [`error.${FAILURE.RAILWAY_UNREACHABLE}`]: 'Railway did not answer.',
  [`error.${FAILURE.RAILWAY_API_FAILED}`]: 'Railway refused a step of the installation.',
  [`error.${FAILURE.RAILWAY_DEPLOY_FAILED}`]: 'The panel did not finish building on Railway.',
  [`error.${FAILURE.RAILWAY_DOMAIN_RECORDS_MISSING}`]: 'Railway did not tell us which DNS records to create.',
  [`error.${FAILURE.CLOUDFLARE_TOKEN_INVALID}`]: 'Cloudflare did not accept that token.',
  [`error.${FAILURE.CLOUDFLARE_TOKEN_UNSCOPED}`]: 'That token can see more than one zone. Create one scoped to this domain only.',
  [`error.${FAILURE.CLOUDFLARE_TOKEN_NO_TTL}`]: 'That token never expires. Create one with an end date of tomorrow.',
  [`error.${FAILURE.CLOUDFLARE_ZONE_NOT_FOUND}`]: 'That token does not cover this domain.',
  [`error.${FAILURE.CLOUDFLARE_UNREACHABLE}`]: 'Cloudflare did not answer.',
  [`error.${FAILURE.CLOUDFLARE_API_FAILED}`]: 'Cloudflare refused a step of the installation.',
  [`error.${FAILURE.DNS_NAME_FORBIDDEN}`]: 'We do not write to the root of your domain or to www.',
  [`error.${FAILURE.DNS_RECORD_EXISTS}`]: 'A DNS record with that name already exists. We never overwrite one — remove it or pick another subdomain.',
  [`error.${FAILURE.CERTIFICATE_TIMEOUT}`]: 'The certificate did not issue in time.',
  [`error.${FAILURE.ADMIN_CREATE_FAILED}`]: 'The panel came up but would not create your account.',
  [`error.${FAILURE.INTERNAL}`]: 'Something went wrong on our side.',
}

export const ptBR = {
  'meta.title': 'Instalar o Linkyard',
  'meta.description': 'Instale o Linkyard na sua conta da Railway, no seu domínio.',

  'brand.name': 'Linkyard',
  'page.title': 'Instalar o',
  'page.title.script': 'Linkyard',
  'page.lede':
    'Isto cria os três serviços na sua própria conta da Railway, no seu domínio, e devolve o painel com a sua conta já criada.',

  'notice.cost': `Três serviços na Railway custam entre US$ ${COST.minUsd.toFixed(2)} e ${COST.maxUsd.toFixed(2)} por mês. O plano Hobby de US$ ${COST.hobbyPlanUsd.toFixed(2)} não cobre.`,
  'notice.storage': 'Guardamos seu e-mail e a data. Nada além disso — o código que grava é aberto.',
  'notice.storage.link': 'Ver o Worker',
  'notice.address': 'O Linkyard só pede token neste endereço.',

  'section.install': 'Sua instalação',
  'section.credentials': 'Suas credenciais',
  'section.credentials.lede':
    'São a última coisa que pedimos e a primeira da qual nos livramos. Nenhuma das duas vai para banco, log ou arquivo.',

  'field.email.label': 'E-mail',
  'field.email.hint': 'É com ele que você entra no painel.',
  'field.password.label': 'Senha do painel',
  'field.password.hint': 'No mínimo 12 caracteres. Sua conta é criada durante a instalação, então nenhuma tela de setup fica aberta.',
  'field.apex.label': 'Domínio',
  'field.apex.hint': 'O domínio como ele aparece na Cloudflare.',
  'field.panelHost.label': 'Subdomínio do painel',
  'field.panelHost.hint': 'Onde você vai gerenciar os links.',
  'field.redirectHost.label': 'Subdomínio de redirect',
  'field.redirectHost.hint': 'Onde seus links curtos respondem. Opcional — dá para adicionar depois.',
  'field.locale.label': 'Idioma do painel',
  'field.timezone.label': 'Fuso horário',
  'field.cloudflareToken.label': 'Token da Cloudflare',
  'field.cloudflareToken.hint': 'Escolha a zona específica e coloque validade de 1 dia. Ele morre sozinho — apagar exigiria uma permissão maior do que esta instalação precisa.',
  'field.railwayToken.label': 'Token da Railway',
  'field.railwayToken.hint': 'Crie um token novo, que não seja usado em nenhum outro lugar. Vamos apagá-lo automaticamente quando a instalação terminar, dando certo ou errado.',

  'guide.railway.title': 'Como criar o token da Railway',
  'guide.railway.step1': 'Abra railway.com/account/tokens.',
  'guide.railway.step2': 'Dê o nome linkyard-install, para você reconhecê-lo se algo der errado.',
  'guide.railway.step3': 'Escolha sua conta, não um projeto — token de projeto não cria projeto.',
  'guide.railway.step4': 'Copie uma vez e cole aqui. Você não vai precisar dele de novo.',

  'guide.cloudflare.title': 'Como criar o token da Cloudflare',
  'guide.cloudflare.step1': 'Abra dash.cloudflare.com/profile/api-tokens e comece pelo modelo Edit zone DNS.',
  'guide.cloudflare.step2': 'Permissões: Zone · DNS · Edit, mais Zone · Zone · Read.',
  'guide.cloudflare.step3': 'Zone Resources: Include · Specific zone · seu domínio. Não use "All zones" — recusamos token que enxerga mais de uma.',
  'guide.cloudflare.step4': 'TTL: coloque a data final para amanhã. É isso que encerra o token, já que apagá-lo exigiria uma permissão maior.',
  'guide.cloudflare.step5': 'Crie, copie, cole aqui.',

  'action.verify': 'Conferir minhas credenciais',
  'action.verifying': 'Conferindo…',
  'action.confirm': 'Criar estes recursos',
  'action.back': 'Mudar alguma coisa',
  'action.open': 'Abrir meu painel',

  'confirm.title': 'Antes de criar qualquer coisa',
  'confirm.account': 'Conta da Railway',
  'confirm.zone': 'Zona da Cloudflare',
  'confirm.cost': 'Custo estimado',
  'confirm.cost.value': `US$ ${COST.minUsd.toFixed(2)}–${COST.maxUsd.toFixed(2)} por mês, cobrados de você pela Railway`,
  'confirm.records': 'Registros que vamos criar',
  'confirm.records.note': 'Só criamos, nunca sobrescrevemos. Se algum desses nomes já existir, a instalação para.',
  'confirm.workspaces': 'Este token alcança mais de um workspace. Vamos usar o primeiro.',

  'progress.title': 'Instalando',
  'progress.events': 'Criado até aqui',

  'phase.verify': 'Conferindo suas credenciais',
  'phase.infra': 'Criando seu painel',
  'phase.domain': 'Reservando seu endereço',
  'phase.dns': 'Configurando o endereço',
  'phase.certificate': 'Esperando o certificado',
  'phase.admin': 'Criando sua conta',
  'phase.cleanup': 'Apagando seu token',

  'event.resource.railway-project': 'Projeto na Railway',
  'event.resource.railway-service': 'Serviço',
  'event.resource.railway-volume': 'Volume',
  'event.resource.railway-service-domain': 'Endereço interno',
  'event.resource.railway-custom-domain': 'Domínio próprio',
  'event.resource.dns-record': 'Registro DNS',
  'event.dns.plan': 'Prestes a escrever:',
  'event.dns.visible': 'Visível no DNS público:',
  'event.certificate.issued': 'Certificado emitido para',

  'done.title': 'Seu painel está no ar',
  'done.body': 'Entre com o e-mail e a senha que você escolheu.',
  'done.redirect': 'Seus links curtos vão responder em',
  'done.token.deleted': 'Seu token da Railway foi apagado e confirmamos que ele não funciona mais.',
  'done.token.unconfirmed': 'Pedimos à Railway para apagar seu token, mas não conseguimos confirmar. Apague à mão em railway.com/account/tokens.',

  'failed.title': 'A instalação parou',
  'failed.body': 'Tudo que este job criou foi removido, e seu token da Railway foi apagado.',

  'manual.title': 'Algumas coisas não puderam ser removidas',
  'manual.body': 'A instalação parou e a limpeza não terminou. Isto existe na sua conta e precisa ser removido à mão:',

  'lang.switch': 'English',
  'footer.repo': 'Código-fonte',
  'footer.license': 'MIT',

  'challenge.title': 'Uma checagem antes',
  'challenge.body':
    'A próxima página é onde você cola seus tokens, e ela não carrega nada de terceiros — nem fonte, nem script. Por isso a checagem acontece aqui.',
  'challenge.submit': 'Continuar',

  [`error.${FAILURE.INPUT_INVALID}`]: 'Algum campo do formulário não está válido. Confira o campo destacado.',
  [`error.${FAILURE.TURNSTILE_FAILED}`]: 'A checagem não passou. Recarregue a página e tente de novo.',
  [`error.${FAILURE.TOO_MANY_JOBS}`]: 'Há instalações demais rodando agora. Tente de novo em alguns minutos.',
  [`error.${FAILURE.JOB_NOT_FOUND}`]: 'Esta instalação não está mais aberta. Comece de novo.',
  [`error.${FAILURE.RAILWAY_TOKEN_INVALID}`]: 'A Railway não aceitou esse token.',
  [`error.${FAILURE.RAILWAY_TOKEN_NOT_ACCOUNT}`]: 'Esse é um token de projeto. Crie um token de conta em railway.com/account/tokens.',
  [`error.${FAILURE.RAILWAY_TOKEN_NOT_FOUND}`]: 'Não encontramos esse token para apagar. Apague à mão em railway.com/account/tokens.',
  [`error.${FAILURE.RAILWAY_TOKEN_AMBIGUOUS}`]: 'Dois dos seus tokens se parecem, então não apagamos nenhum. Apague este à mão.',
  [`error.${FAILURE.RAILWAY_WORKSPACE_MISSING}`]: 'Esse token não alcança nenhum workspace.',
  [`error.${FAILURE.RAILWAY_RATE_LIMITED}`]: 'A Railway está limitando as chamadas desta conta. Tente de novo em alguns minutos.',
  [`error.${FAILURE.RAILWAY_UNREACHABLE}`]: 'A Railway não respondeu.',
  [`error.${FAILURE.RAILWAY_API_FAILED}`]: 'A Railway recusou uma etapa da instalação.',
  [`error.${FAILURE.RAILWAY_DEPLOY_FAILED}`]: 'O painel não terminou de subir na Railway.',
  [`error.${FAILURE.RAILWAY_DOMAIN_RECORDS_MISSING}`]: 'A Railway não informou quais registros DNS criar.',
  [`error.${FAILURE.CLOUDFLARE_TOKEN_INVALID}`]: 'A Cloudflare não aceitou esse token.',
  [`error.${FAILURE.CLOUDFLARE_TOKEN_UNSCOPED}`]: 'Esse token enxerga mais de uma zona. Crie um restrito só a este domínio.',
  [`error.${FAILURE.CLOUDFLARE_TOKEN_NO_TTL}`]: 'Esse token não expira. Crie um com data final para amanhã.',
  [`error.${FAILURE.CLOUDFLARE_ZONE_NOT_FOUND}`]: 'Esse token não cobre este domínio.',
  [`error.${FAILURE.CLOUDFLARE_UNREACHABLE}`]: 'A Cloudflare não respondeu.',
  [`error.${FAILURE.CLOUDFLARE_API_FAILED}`]: 'A Cloudflare recusou uma etapa da instalação.',
  [`error.${FAILURE.DNS_NAME_FORBIDDEN}`]: 'Não escrevemos na raiz do seu domínio nem no www.',
  [`error.${FAILURE.DNS_RECORD_EXISTS}`]: 'Já existe um registro DNS com esse nome. Nunca sobrescrevemos — remova ele ou escolha outro subdomínio.',
  [`error.${FAILURE.CERTIFICATE_TIMEOUT}`]: 'O certificado não foi emitido a tempo.',
  [`error.${FAILURE.ADMIN_CREATE_FAILED}`]: 'O painel subiu, mas não criou sua conta.',
  [`error.${FAILURE.INTERNAL}`]: 'Algo deu errado do nosso lado.',
}

export const DICTIONARIES = { en, 'pt-BR': ptBR }
export const LOCALES = Object.keys(DICTIONARIES)

export function translator(locale) {
  const dictionary = DICTIONARIES[locale] ?? en
  return (key) => dictionary[key] ?? en[key] ?? key
}

/** A query parameter wins over the browser; a browser asking for pt anything gets pt-BR. */
export function resolveLocale({ query, acceptLanguage } = {}) {
  if (query && DICTIONARIES[query]) return query
  const header = String(acceptLanguage ?? '').toLowerCase()
  if (/\bpt\b|pt-/.test(header)) return 'pt-BR'
  return 'en'
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const REPO_URL = 'https://github.com/paulotfchaves/linkyard'
const WORKER_URL = `${REPO_URL}/blob/main/setup/worker/index.js`

function field({ id, type = 'text', label, hint, required = true, autocomplete = 'off', placeholder = '', extra = '' }) {
  return `<div class="field">
      <label class="field__label" for="${id}">${escapeHtml(label)}</label>
      <input class="field__input" id="${id}" name="${id}" type="${type}" autocomplete="${autocomplete}"
        autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${escapeHtml(placeholder)}"
        ${required ? 'required' : ''} ${extra}>
      ${hint ? `<p class="field__hint">${escapeHtml(hint)}</p>` : ''}
    </div>`
}

function guide(t, title, steps) {
  return `<details class="guide">
      <summary class="guide__summary">${escapeHtml(t(title))}</summary>
      <ol class="guide__steps">${steps.map((step) => `<li>${escapeHtml(t(step))}</li>`).join('')}</ol>
    </details>`
}

function shell({ locale, title, description, body, otherLocale, t, scripts = '', bodyAttrs = '' }) {
  return `<!doctype html>
<html lang="${locale}" data-motion="enhanced">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="stylesheet" href="/style.css">
</head>
<body${bodyAttrs}>
<header class="bar">
  <span class="wordmark"><span class="wordmark__glyph"></span>${escapeHtml(t('brand.name'))}</span>
  <a class="bar__lang" href="?lang=${otherLocale}">${escapeHtml(t('lang.switch'))}</a>
</header>
${body}
<footer class="foot">
  <a href="${REPO_URL}">${escapeHtml(t('footer.repo'))}</a>
  <span>${escapeHtml(t('footer.license'))}</span>
</footer>
${scripts}
</body>
</html>`
}

/**
 * @param {object} [options]
 * @param {boolean} [options.resume] the visitor's cookie points at a job already
 *   running — reloading the tab must return to the progress view rather than to
 *   an empty form, because that view is the only copy of the inventory
 */
export function renderPage({ locale = 'en', timezone = 'UTC', resume = false } = {}) {
  const t = translator(locale)
  const otherLocale = locale === 'en' ? 'pt-BR' : 'en'

  const phases = PHASES.map(
    (phase) => `<li class="phase" data-phase="${phase}" data-status="pending">
        <span class="phase__dot"></span><span class="phase__label">${escapeHtml(t(`phase.${phase}`))}</span>
      </li>`
  ).join('')

  const body = `<main class="frame">
  <section class="ember card">
    <div class="card__inner">
      <h1 class="card__title reveal reveal-1">${escapeHtml(t('page.title'))} <span class="script">${escapeHtml(t('page.title.script'))}</span></h1>
      <p class="card__lede reveal reveal-2">${escapeHtml(t('page.lede'))}</p>

      <ul class="notices reveal reveal-3">
        <li>${escapeHtml(t('notice.cost'))}</li>
        <li>${escapeHtml(t('notice.storage'))} <a href="${WORKER_URL}">${escapeHtml(t('notice.storage.link'))}</a></li>
        <li>${escapeHtml(t('notice.address'))}</li>
      </ul>

      <form id="install" class="state state--form reveal reveal-4" novalidate>
        <h2 class="state__heading">${escapeHtml(t('section.install'))}</h2>
        ${field({ id: 'email', type: 'email', label: t('field.email.label'), hint: t('field.email.hint'), placeholder: 'you@example.com' })}
        ${field({ id: 'password', type: 'password', label: t('field.password.label'), hint: t('field.password.hint'), autocomplete: 'new-password', extra: 'minlength="12"' })}
        ${field({ id: 'apex', label: t('field.apex.label'), hint: t('field.apex.hint'), placeholder: 'example.com' })}
        ${field({ id: 'panelHost', label: t('field.panelHost.label'), hint: t('field.panelHost.hint'), placeholder: 'links' })}
        ${field({ id: 'redirectHost', label: t('field.redirectHost.label'), hint: t('field.redirectHost.hint'), placeholder: 'go', required: false })}
        <div class="field">
          <label class="field__label" for="locale">${escapeHtml(t('field.locale.label'))}</label>
          <select class="field__input" id="locale" name="locale">
            <option value="en"${locale === 'en' ? ' selected' : ''}>English</option>
            <option value="pt-BR"${locale === 'pt-BR' ? ' selected' : ''}>Português (Brasil)</option>
          </select>
        </div>
        ${field({ id: 'timezone', label: t('field.timezone.label'), placeholder: timezone })}

        <h2 class="state__heading state__heading--split">${escapeHtml(t('section.credentials'))}</h2>
        <p class="state__lede">${escapeHtml(t('section.credentials.lede'))}</p>
        ${field({ id: 'cloudflareToken', type: 'password', label: t('field.cloudflareToken.label'), hint: t('field.cloudflareToken.hint') })}
        ${guide(t, 'guide.cloudflare.title', ['guide.cloudflare.step1', 'guide.cloudflare.step2', 'guide.cloudflare.step3', 'guide.cloudflare.step4', 'guide.cloudflare.step5'])}
        ${field({ id: 'railwayToken', type: 'password', label: t('field.railwayToken.label'), hint: t('field.railwayToken.hint') })}
        ${guide(t, 'guide.railway.title', ['guide.railway.step1', 'guide.railway.step2', 'guide.railway.step3', 'guide.railway.step4'])}

        <p class="error" id="form-error" hidden></p>
        <button class="button" type="submit" data-idle="${escapeHtml(t('action.verify'))}" data-busy="${escapeHtml(t('action.verifying'))}">
          ${escapeHtml(t('action.verify'))}<span class="button__arrow" aria-hidden="true">↗</span>
        </button>
      </form>

      <section class="state state--confirm" id="confirm" hidden>
        <h2 class="state__heading">${escapeHtml(t('confirm.title'))}</h2>
        <dl class="facts">
          <dt>${escapeHtml(t('confirm.account'))}</dt><dd id="confirm-account"></dd>
          <dt>${escapeHtml(t('confirm.zone'))}</dt><dd id="confirm-zone"></dd>
          <dt>${escapeHtml(t('confirm.cost'))}</dt><dd>${escapeHtml(t('confirm.cost.value'))}</dd>
        </dl>
        <h3 class="state__subheading">${escapeHtml(t('confirm.records'))}</h3>
        <ul class="records" id="confirm-records"></ul>
        <p class="state__note">${escapeHtml(t('confirm.records.note'))}</p>
        <p class="error" id="confirm-error" hidden></p>
        <div class="actions">
          <button class="button" type="button" id="confirm-go">${escapeHtml(t('action.confirm'))}<span class="button__arrow" aria-hidden="true">↗</span></button>
          <button class="button button--quiet" type="button" id="confirm-back">${escapeHtml(t('action.back'))}</button>
        </div>
      </section>

      <section class="state state--progress" id="progress" hidden>
        <h2 class="state__heading">${escapeHtml(t('progress.title'))}</h2>
        <ol class="phases">${phases}</ol>
        <h3 class="state__subheading">${escapeHtml(t('progress.events'))}</h3>
        <ul class="events" id="events"></ul>
      </section>

      <section class="state state--done" id="done" hidden>
        <h2 class="state__heading" id="done-title"></h2>
        <p class="state__lede" id="done-body"></p>
        <ul class="records" id="done-list" hidden></ul>
        <p class="state__note" id="done-token"></p>
        <a class="button" id="done-open" href="#" hidden>${escapeHtml(t('action.open'))}<span class="button__arrow" aria-hidden="true">↗</span></a>
      </section>
    </div>
  </section>
</main>`

  return shell({
    locale,
    title: t('meta.title'),
    description: t('meta.description'),
    body,
    otherLocale,
    t,
    scripts: '<script src="/app.js" defer></script>',
    bodyAttrs: resume ? ' data-resume="progress"' : '',
  })
}

/**
 * The Turnstile page, and why it is a page of its own.
 *
 * Control 8 asks for Turnstile; control 1 forbids any third-party origin on the
 * route that touches a credential, and Turnstile is a script served by
 * Cloudflare. Both hold if the challenge happens somewhere else: this page loads
 * the widget, posts the result back here, and the installer route stays free of
 * anyone else's JavaScript. It carries no credential field, so the wider policy
 * it needs costs nothing.
 */
export function renderChallenge({ locale = 'en', siteKey }) {
  const t = translator(locale)
  const otherLocale = locale === 'en' ? 'pt-BR' : 'en'
  const body = `<main class="frame">
  <section class="ember card">
    <div class="card__inner">
      <h1 class="card__title">${escapeHtml(t('challenge.title'))}</h1>
      <p class="card__lede">${escapeHtml(t('challenge.body'))}</p>
      <form method="post" action="/challenge">
        <div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-theme="dark"></div>
        <button class="button" type="submit">${escapeHtml(t('challenge.submit'))}<span class="button__arrow" aria-hidden="true">↗</span></button>
      </form>
    </div>
  </section>
</main>`

  return shell({
    locale,
    title: t('challenge.title'),
    description: t('meta.description'),
    body,
    otherLocale,
    t,
    scripts: '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>',
  })
}

// Served from /app.js so `script-src 'self'` needs no nonce and no exception.
// It renders only strings the server sent, and clears both credential fields the
// moment the request leaves the browser.
export const CLIENT_SCRIPT = `(() => {
  const form = document.getElementById('install')
  if (!form) return
  const confirmPane = document.getElementById('confirm')
  const progressPane = document.getElementById('progress')
  const donePane = document.getElementById('done')
  const formError = document.getElementById('form-error')
  const confirmError = document.getElementById('confirm-error')
  const submit = form.querySelector('button[type="submit"]')

  const show = (pane) => {
    for (const node of [form, confirmPane, progressPane, donePane]) node.hidden = node !== pane
  }
  const fail = (node, message) => {
    node.textContent = message
    node.hidden = false
  }
  const post = async (path, payload) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    })
    return { ok: response.ok, body: await response.json().catch(() => ({})) }
  }

  const renderRecords = (target, records) => {
    target.replaceChildren()
    for (const record of records || []) {
      const item = document.createElement('li')
      item.textContent = record.type + '  ' + record.name + (record.value && record.value !== 'pending' ? '  →  ' + record.value : '')
      target.append(item)
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    formError.hidden = true
    submit.disabled = true
    submit.textContent = submit.dataset.busy

    const data = Object.fromEntries(new FormData(form).entries())
    // The tokens leave the page here and are gone from it immediately: a value
    // still sitting in an input is a value a later script, or a browser restore,
    // can read.
    form.querySelector('#railwayToken').value = ''
    form.querySelector('#cloudflareToken').value = ''

    const { ok, body } = await post('/api/verify', data)
    submit.disabled = false
    submit.textContent = submit.dataset.idle

    if (!ok) {
      fail(formError, body.message || '')
      return
    }

    document.getElementById('confirm-account').textContent = [body.account.workspace, body.account.email].filter(Boolean).join(' · ')
    document.getElementById('confirm-zone').textContent = body.zone.name || ''
    renderRecords(document.getElementById('confirm-records'), body.records)
    show(confirmPane)
  })

  document.getElementById('confirm-back').addEventListener('click', () => show(form))

  document.getElementById('confirm-go').addEventListener('click', async () => {
    confirmError.hidden = true
    const { ok, body } = await post('/api/confirm', {})
    if (!ok) {
      fail(confirmError, body.message || '')
      return
    }
    show(progressPane)
    poll()
  })

  const paint = (view) => {
    for (const phase of view.phases) {
      const node = progressPane.querySelector('[data-phase="' + phase.key + '"]')
      if (!node) continue
      node.dataset.status = phase.status
      node.querySelector('.phase__label').textContent = phase.label
    }
    const events = document.getElementById('events')
    events.replaceChildren()
    for (const event of view.events) {
      const item = document.createElement('li')
      item.textContent = event.text
      events.append(item)
    }
  }

  const finish = (view) => {
    const title = document.getElementById('done-title')
    const bodyText = document.getElementById('done-body')
    const list = document.getElementById('done-list')
    const token = document.getElementById('done-token')
    const open = document.getElementById('done-open')

    if (view.state === 'done') {
      title.textContent = view.strings.doneTitle
      bodyText.textContent = view.strings.doneBody
      open.href = view.result.panelUrl
      open.hidden = false
    } else {
      const manual = view.state === 'manual_cleanup_required'
      title.textContent = manual ? view.strings.manualTitle : view.strings.failedTitle
      const tail = manual ? view.strings.manualBody : view.strings.failedBody
      bodyText.textContent = [view.failure ? view.failure.message : '', tail].filter(Boolean).join(' ')
      const items = manual ? view.manualCleanup : []
      if (items.length) {
        list.replaceChildren()
        for (const entry of items) {
          const item = document.createElement('li')
          item.textContent = entry
          list.append(item)
        }
        list.hidden = false
      }
    }
    token.textContent = view.tokenDeleted && view.tokenDeleted.confirmed ? view.strings.tokenDeleted : view.strings.tokenUnconfirmed
    show(donePane)
  }

  async function poll() {
    const response = await fetch('/api/status')
    if (!response.ok) return
    const view = await response.json()
    paint(view)
    if (view.state === 'running') {
      setTimeout(poll, 1500)
      return
    }
    finish(view)
  }

  // A reload during an install returns to the progress view. The alternative is
  // an empty form while a job builds resources in the visitor's account, with
  // the list of what exists gone from the only place it was ever shown.
  if (document.body.dataset.resume === 'progress') {
    show(progressPane)
    poll()
  }
})()`
