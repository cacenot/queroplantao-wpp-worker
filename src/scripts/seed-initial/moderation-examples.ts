import type { ModerationConfigExample } from "../../db/schema/moderation-configs.ts";

export const MODERATION_EXAMPLES: ModerationConfigExample[] = [
  {
    text: `💎 *MedPlantões - Captação Médica* 💎
Cod.: 92

📌 *Olá Drs.(as.)!*

Estamos com disponibilidade de vagas para médicos Médico Cardiolgista e oftalmologista em Clincia de Grande Porte localizada na região de Cotia SP

Interessados chamar inbox

*Faça seu cadastro e receba as melhores vagas no seu Email!*
🌐  🌐

☎ Caso tenha interesse nas vagas, entre em contato com um de nossos escalistas, links abaixo:

*Disponível das 06h30 às 21h00 (adm Juliana)*
https://wa.me/5511943670559

*Visite-nos no Linkedin*
🎦 https://www.linkedin.com/company/medplantoes 🎦

📋Abra ou feche sua empresa com a MedAssist - informações inbox📋`,
    analysis: {
      reason:
        "Anúncio de vagas médicas com convite para captação de profissionais para empresa de consultoria externa (MedAssist).",
      partner: null,
      category: "service_sales",
      confidence: 0.98,
      action: "remove",
    },
  },
  {
    text: `🚨 Vai começar a estudar pra residência agora e ainda quer ganhar curso de ATB + Radiologia grátis? 👀📚

Entrando na lista de espera do Semiextensivo R1 2026, você garante:
✨ Cursos de Antibióticos + Radiologia gratuitos
💸 Descontos exclusivos na abertura das vendas
⚡ Informações do lançamento em primeira mão

🔗 Link para garantir os benefícios:
https://experiencias.medway.com.br/lista-de-espera-semiextensivo-r1?utm_source=Embaixadores&utm_medium=BIANCAFERNANDES
Organização para estudar. Aprofundamento certo para passar.
Medway
https://experiencias.medway.com.br/lista-de-espera-semiextensivo-r1?utm_source=Embaixadores&utm_medium=BIANCAFERNANDES`,
    analysis: {
      reason:
        "O conteúdo é uma promoção de curso preparatório para residência (service_sales) com link comercial externo, sendo propaganda não relacionada a vagas de plantão.",
      partner: null,
      category: "service_sales",
      confidence: 1,
      action: "remove",
    },
  },
  {
    text: `📢 Vagas para *Psiquiatria* – TELEMEDICINA
💻 Atendimento 100% online
Trabalhe de qualquer lugar do Brasil

📲 Tem interesse? Faça seu login gratuito e acesse as vagas:
https://oportunidades.sinaxys.com/ni3DTNIB

📌 Canal oficial Sinaxys:
https://oportunidades.sinaxys.com/dS8VrXTQ
https://oportunidades.sinaxys.com/ni3DTNIB
oportunidades.sinaxys.com`,
    analysis: {
      reason:
        "A mensagem promove uma plataforma concorrente de vagas de plantão e saúde, violando as regras de concorrência.",
      partner: null,
      category: "competitor_promotion",
      confidence: 1,
      action: "remove",
    },
  },
  {
    text: `🦴*ARTIGO COMPLETO*

✍🏻*SOMENTE 05 AUTORES*



🦴*TRAUMATISMO RAQUIMEDULAR E FRATURAS DA COLUNA VERTEBRAL: UM ESTUDO ORTOPÉDICO*


📌
*PUBLICAÇÃO COMO ARTIGO  + CAPÍTULO DE LIVRO EM EBOOK DIGITAL INTERNACIONAL  E ALTO FATOR DE IMPACTO*


🩺DOI/ISBN INDIVIDUAL



👆🏻INTERESSADOS

https://wa.me/556493125018?text=QUERO%20PUBLICAR

Link do grupo

https://chat.whatsapp.com/CeclfPxRAFgEy85zcVVfVf
https://wa.me/556493125018?text=QUERO%20PUBLICAR`,
    analysis: {
      reason:
        "A mensagem promove venda de serviço de publicação acadêmica e contém link para outro grupo de WhatsApp, configurando concorrência e venda de serviço.",
      partner: null,
      category: "product_sales",
      confidence: 1,
      action: "remove",
    },
  },
  {
    text: `🩺 *VAGAS DE TELEMEDICINA* 🩺

💎 *MedPlantões - Captação Médica* 💎
Cod.: 00

*JORNAL DE VAGAS PARA TELEMEDICINA*

📌 *Olá Drs.(as.)!*

Estamos com disponibilidade de vagas para médicos nas especialidades:

- ⁠Radiologista

*RQE*
*Pode ser exercida de qualquer região do País*

*Faça seu cadastro e receba as melhores vagas no seu Email!*
🌐  🌐

☎ Caso tenha interesse nas vagas, entre em contato com um de nossos escalistas, links abaixo:

*Disponível das 06h30 às 21h00 (adm Juliana)*
https://wa.me/5511943670559

*Visite-nos no Linkedin*
🎦 https://www.linkedin.com/company/medplantoes 🎦

📋Abra ou feche sua empresa com a MedAssist - informações inbox📋
Conta comercial
ADMMP Juliana
https://wa.me/5511943670559`,
    analysis: {
      reason:
        "Anúncio de vagas de telemedicina por empresa externa. Como não é parceiro e possui links comerciais externos, deve ser removido.",
      partner: null,
      category: "service_sales",
      confidence: 1,
      action: "remove",
    },
  },
  {
    text: `Boa tarde gente!!
Passando aqui pra compartilhar o cupom caso alguém precise. Foi liberado um desconto HOJE!
Ajuda e agiliza demais pras prescrições em plantão upa, UBS etc. 🤌

Cupom para o desconto do plano anual (fica 27,62 mensal só):
https://www.wemeds.com.br/assine`,
    analysis: {
      reason:
        "O conteúdo é uma promoção comercial de um software de prescrição médica sem vínculo de parceria, devendo ser removido segundo as regras.",
      partner: null,
      category: "service_sales",
      confidence: 1,
      action: "remove",
    },
  },
  {
    text: `JÁ PENSOU EM ATUAR COMO PERITO MÉDICO JUDICIAL? ⚖️

Se você possui CRM ativo, já pode cadastrar. Sem necessidade de gastar com cursos!!!`,
    analysis: {
      reason:
        "A mensagem promove um serviço de consultoria ou orientação profissional sobre perícia médica, configurando venda de serviço/oportunidade de carreira fora de vagas diretas.",
      partner: null,
      category: "service_sales",
      confidence: 1,
      action: "remove",
    },
  },
  {
    text: `🏥 *UPA IPIRANGA AUGUSTO G. DE MATTOS* 🏥
🗺️ _Vila Ipiranga/São Paulo-SP_

O _Time_ *Sólida Saúde* 🪨🐍 traz sua organização e compromisso com as equipes para a gestão da *UPA IPIRANGA*.

_A unidade conta com:_

🏥 _Ótima infraestrutura_
🖥️ _Equipamentos de qualidade_
🤝 _Equipe muito parceira_
📌 _Fixos disponíveis a partir de MAIO_

📃 \`\`\`REQUISITOS: A PARTIR DE R2, RQE, RESIDENCIA COMPLETA OU TITULO\`\`\`

👨🏻‍⚕️ *PLANTÃO:*

🔪 *CIRURGIA GERAL*

🌚 *19:00 - 07:00*
🗓️ 18/04, Sábado
🗓️ 25/04, Sábado

📢 *Entre em nossos grupos:*
https://linktr.ee/bng_hub_vagas

🏥 *UPA IPIRANGA AUGUSTO GOMES DE MATTOS*
📍 _R. Júlio Felipe Guedes, 200, São Paulo/SP_
🚗🗺️ *https://waze.com/ul/h6gyce3te8*

*Interessou? Me chama!* 😉

_Escalista Responsável_
📱 *Jonata N.*.: wa.me//5511952134811

_Time_ *Sólida Saúde* 🪨🐍
https://linktr.ee/bng_hub_vagas`,
    analysis: {
      reason:
        "A mensagem promove um grupo de vagas externo via link, desde que haja uma oferta de vaga real, não tem problema.",
      partner: null,
      category: "job_opportunity",
      confidence: 0.98,
      action: "allow",
    },
  },
  {
    text: `🩺 *ANESTESIO PARANÁ*

*VAGA ANESTESIOLOGISTA PARANÁ*
https://chat.whatsapp.com/E9TQ0pzO38c1bK3I12U2hz?mode=gi_t

🚨 *VAGA ANESTESIOLOGIA*🚨

📍 *PARANAGUÁ – PR*
🏥 Hospital Regional do Litoral

 *Início imediato*

 *Estrutura:* Hospital completo, com 30 leitos de UTI

 *Atuação:* Anestesista responsável por apenas 1 sala

 *Modelo de contratação:* Sócio cotista
*Pagamento:* Entre os dias 15 e 20 do mês subsequente

_Conforto e alimentação no local_

📩 Interessados, entrar em contato para mais informações.

☎️. *LETÍCIA RAMIREZ*
(47) 98803-0361
https://wa.me/554788030361

🏛️ *INBRAM* _Instituto brasileiro de Governança e Compliance Médico_`,
    analysis: {
      reason:
        "A mensagem promove um grupo de WhatsApp concorrente, o que viola a regra de competitor_promotion, porém é um parceiro oficial.",
      partner: "inbram",
      category: "job_opportunity",
      confidence: 1,
      action: "allow",
    },
  },
  {
    text: `Uma lista de mais de 140 cursos.
Referentes ao ano passado e esse ano.
Residência, Revalida, Especialização e Título Especialista.
Por um valor justo!
400,00
(Esse final de semana)
47991665549`,
    analysis: {
      reason:
        "A mensagem oferece venda de cursos pirateados ou de origem duvidosa em massa, violando as regras da comunidade.",
      partner: null,
      category: "piracy",
      confidence: 1,
      action: "ban",
    },
  },
  {
    text: "Esse pilantra faz pishing , se colar, colou",
    analysis: {
      reason: "A mensagem é uma denúncia de golpe/phishing, discussão normal em grupo.",
      partner: null,
      category: "clean",
      confidence: 1,
      action: "allow",
    },
  },
  {
    text: "Poderia me dar um resumo sobre kkk",
    analysis: {
      reason: "Conversa normal em grupo",
      partner: null,
      category: "clean",
      confidence: 1,
      action: "allow",
    },
  },
  {
    text: "Processo vai chegar na sua casa em breve",
    analysis: {
      reason:
        "A mensagem é uma ameaça ambígua, classificada como profanity/ataque pessoal pelo tom intimidador, porém não a moderação não é para esse tipo de menssagem.",
      partner: null,
      category: "clean",
      confidence: 0.95,
      action: "allow",
    },
  },
  {
    text: "Tem FDP pra tudo",
    analysis: {
      reason:
        "A mensagem utiliza linguagem ofensiva, porém se refere a outra pessoa talvez fora do grupo, é uma discussão no grupo, remover seria demais para essa moderação.",
      partner: null,
      category: "clean",
      confidence: 0.95,
      action: "allow",
    },
  },
  {
    text: `Pessoal, uma novidade pra quem está na residência de Radiologia ou se preparando para as *provas teóricas e teórico-práticas de Radiologia e Ultrassonografia do CBR*👇

O *QuestRad* é um banco de questões com *todas* as provas antigas, organizado por temas e com estatísticas pra ajudar a identificar onde você precisa melhorar.

Tem 7 dias de teste grátis — se não curtir, dá pra cancelar direto pela Hotmart, sem complicação.

Pra quem quiser dar uma olhada: https://questrad.hotmart.host/questrad-d34a58f0-13ec-45c0-a646-a86b0d49a1bf`,
    analysis: {
      reason:
        "O conteúdo é uma promoção comercial de curso/ferramenta de estudos para médicos, não configurando vaga ou denúncia, logo deve ser removida.",
      partner: null,
      category: "service_sales",
      confidence: 1,
      action: "remove",
    },
  },
  {
    text: `Bom dia , se você vai começar o mês de abril do mesmo jeito te convido a me chamar para bater um papo para te apresentar uma maneira de você garantir seu futuro , e alcançar coisas que jamais teria alcançado.
To te esperando.`,
    analysis: {
      reason: "conversa normal de grupo",
      partner: null,
      category: "clean",
      confidence: 1,
      action: "allow",
    },
  },
  {
    text: "Mandaram mensagem pedindo dinheiro para os meus pais",
    analysis: {
      reason: "conversa normal de grupo",
      partner: null,
      category: "clean",
      confidence: 1,
      action: "allow",
    },
  },
  {
    text: "Ontem vc disse que ia matar a moça,  vem aqui",
    analysis: {
      reason:
        "A mensagem contém uma ameaça de violência grave, o que viola as diretrizes de segurança e convivência, sendo classificada como profanity.",
      partner: null,
      category: "profanity",
      confidence: 1,
      action: "remove",
    },
  },
  {
    text: `Médico, sua especialidade é cuidar de pessoas — a nossa é cuidar da sua contabilidade.
Elimine a burocracia e tenha uma gestão financeira à altura da sua carreira.

Venha conosco 🤝`,
    analysis: {
      reason:
        "A mensagem é uma publicidade direta de serviços contábeis, não sendo uma vaga de plantão ou conteúdo clínico, logo deve ser removida.",
      partner: null,
      category: "service_sales",
      confidence: 1,
      action: "remove",
    },
  },
  {
    text: "Remedio pra vagabundo é aquela massagem pra fazer dormir sem sono",
    analysis: {
      reason:
        "A mensagem utiliza linguagem agressiva e conotação violenta, mas é discussão acalorada.",
      partner: null,
      category: "clean",
      confidence: 0.95,
      action: "allow",
    },
  },
  {
    text: "Em sp 85 corte masculino kkkk",
    analysis: {
      reason: "Mensagem normal de grupo",
      partner: null,
      category: "clean",
      confidence: 1,
      action: "allow",
    },
  },
  {
    text: `🎮Nova plataforma de slots, novos jogos🎮🔥Alta taxa de vitória, saques rápidos🔥Clique neste link para entrar no jogo❤️‍🔥👇👇❤️🎮🔥👇👇❤️‍🔥

Link: https://tk7.games/?c=16724

💸 🎰👆👆🎰💸🚀🚀Taxa de vitória de até 999%🚀🚀💰💸Ganhe até 9999 em dinheiro diariamente💰💸🎁Recompensas misteriosas esperam por você🎁💥Nova plataforma de slots💥🎉Milhares de jogos, sempre há algo para você! Uma para você! 🎉🎉`,
    analysis: {
      reason:
        "A mensagem é claramente spam de jogos de azar e cassinos online, violando as regras da plataforma.",
      partner: null,
      category: "gambling_spam",
      confidence: 1,
      action: "ban",
    },
  },
  {
    text: `Oi pessoal, compartilhar uma dica pra vocês😊. Pra dar uma maior segurança nos atendimentos/fazer excelentes prescrições:

Tô usando esse ano e ajuda muito nos plantoes. O *WeMeds*. Comparei com o whitebook e achei o Wemeds bem mais completo e barato (de 46,65 -> fica 27,62 mensal no cupom desconto)!

Ele tem prescrições prontas ambulatorial e hospitalar, calculadora pediatrica, exames indicados, IA com conduta baseada em evidência (gosto bastante pra guiar casos mais complexos 😬).  Funciona OFFLINE (salva muito). Abre no app e web.

Obs: precisa comprar pelo site e nao pelo app. E plano anual e não mensal para o desconto funcionar.
https://www.wemeds.com.br/assine

Meu cupom caso vcs precisem assinar:
🏷JESSICAMOTA15`,
    analysis: {
      reason:
        "A mensagem promove um produto (aplicativo médico) com link de afiliado e cupom, configurando venda de serviço/produto.",
      partner: null,
      category: "service_sales",
      confidence: 1,
      action: "remove",
    },
  },
  {
    text: `Estão abertas as *inscrições para a nova turma do PALS – Suporte Avançado de Vida em Pediatria* , treinamento essencial para profissionais da saúde que atuam no atendimento de emergências pediátricas .

O PALS é um curso fundamental e amplamente exigido em serviços de urgência e emergência , sendo um importante diferencial para atuação profissional.

📅 Datas: 24, 25 e 26 de abril
⏱ Duração: 16 horas
👥 Turma reduzida: 8 alunos
✔️ Coffee break incluído
✔️ 1 hora de almoço (não incluso)

💰 Investimento: R$ 1.750,00
(em até 6x de R$ 291,67 sem juros no boleto/cartão/pix)

📍 Local:
TOTEMAX – Centro de Simulação Realística em Saúde
Av. José Maria de Albuquerque Freitas, 253.

Para garantir sua vaga, basta preencher o formulário e realizar o pagamento pelos links abaixo:

📋 Formulário de inscrição:
https://forms.cloud.microsoft/r/BvBEWftmPH

💳 Link de pagamento:
https://www.asaas.com/c/t7iys0jklqnso13x

⚠️ A vaga é confirmada após inscrição e pagamento.
As vagas são limitadas .
Microsoft Forms
https://forms.cloud.microsoft/r/BvBEWftmPH`,
    analysis: {
      reason:
        "Mensagem é uma propaganda completa de um curso de capacitação médica, o que se enquadra na categoria de venda de serviços.",
      partner: null,
      category: "service_sales",
      confidence: 1,
      action: "remove",
    },
  },
  {
    text: "Faça uma pós de geriatria e atenda particular",
    analysis: {
      reason:
        "Um participante recomendando que outra profissional se especialize para atender particular",
      partner: null,
      category: "clean",
      confidence: 1,
      action: "allow",
    },
  },
  {
    text: `*INSCRIÇÕES PRORROGADAS. ÚLTIMOS DIAS!!!*

Nosso WhatsApp de contato:
 https://wa.me/message/APFJRTBIVGSUE1`,
    analysis: {
      reason:
        "Mensagem promocional de um serviço externo sem vaga de plantão explícita, configurando venda de serviço/curso sem relação direta com a rede de parceiros.",
      partner: null,
      category: "service_sales",
      confidence: 1,
      action: "remove",
    },
  },
  {
    text: `🏛️ *ANESTESIOLOGIA PARANÁ*

*VAGA ANESTESIOLOGISTA PARANÁ*
https://chat.whatsapp.com/E9TQ0pzO38c1bK3I12U2hz?mode=gi_t

🚨 *VAGA ANESTESIOLOGIA* 🚨

📍 *Paranaguá – PR*
🏥 Hospital Regional do Litoral

 *Início imediato*

 *Estrutura:* Hospital completo, com 30 leitos de UTI

 *Atuação:* Anestesista responsável por apenas 1 sala

 *Modelo de contratação:* Sócio cotista
*Pagamento:* Entre os dias 15 e 20 do mês subsequente

_Conforto e alimentação no local_

📩 Interessados, entrar em contato para mais informações.

☎️ *LÍDER OPERACIONAL: ANDRESSA SANTOS*
(47) 99264-7983
https://wa.me/message/5GJKX2VZLCLAO1

☎️ *GUSTAVO ALEXANDRE*
(47) 9 9177-8115
https://wa.me/message/NGBNM57APOETK1

☎️ *VITOR HORING*
(47) 98887-1024
https://wa.me/message/ZONLS532RPUBB1

*☎️ CINTHIA LOPES*
(47) 99129-0858
https://wa.me/554791290858

_ENTRE EM NOSSOS GRUPOS_

ANESTESIOLOGIA - SÃO MIGUEL DO IGUAÇU PARANÁ
https://chat.whatsapp.com/FUHQnwVuxoS2zzdmj21bOw?mode=gi_t

ANESTESIOLOGIA - GUARAPUAVA
https://chat.whatsapp.com/IKjlFx4RjhBCV3koTd4nt2?mode=gi_t

ANESTESIOLOGIA - PARANÁ
https://chat.whatsapp.com/E9TQ0pzO38c1bK3I12U2hz?mode=gi_t

🏛️ *INBRAM* _Instituto brasileiro de Governança e Compliance Médico_`,
    analysis: {
      reason: "A mensagem foi enviada por um partner e está liberada.",
      partner: "inbram",
      category: "clean",
      confidence: 1,
      action: "allow",
    },
  },
  {
    text: `*Ana Carine :*
📢 Estamos Contratando!
A ContaDoc está buscando profissionais para integrar nossas equipes hospitalares. Temos oportunidades abertas nas seguintes especialidades:
• Emergência;
• Unidade de Internação;
• Terapia Intensiva;
• Ginecologia Obstetrícia;
• Ortopedia;
• Pediatria.
Oferecemos suporte completo e estruturamos toda a burocracia necessária para a sua atuação hospitalar, permitindo que você foque no que realmente importa: o cuidado ao paciente.
🔗 Link para inscrição: https://contadoc-1.rds.land/01-contadoc-contratacao-landing-page`,
    analysis: {
      reason:
        "A mensagem divulga oportunidades de vagas em diversas especialidades mas não informa local, valores, datas e ainda tem um link para uma plataforma externa.",
      partner: null,
      category: "competitor_promotion",
      confidence: 1,
      action: "remove",
    },
  },
  {
    text: `* *DERMATOLOGIA👩🏻‍⚕️*

🏥 *SEDE*
📍 _Alameda Santos, 2313 - 3° andar (esquina com a Haddock Lobo)_

        *\`DERMATOLOGIA\`*



📆 08/04 QUARTA FEIRA
⏰ 08:00 as 17:00

📆 15/04 QUARTA FEIRA
⏰ 08:00 as 17:00


*✓ CERTIFICADO COM RQE*
*✓PAGAMENTO A VISTA OU FOLHA*

> Nos siga nas redes sociais
📷 instagram.com/medtrustservicosmedicos

🔗 medtrust.com.br

\`Entre em contato!\`
📲https://wa.me/message/GSQS5DHJT527K1
Conta comercial
Medtrust Serviços Médicos
https://wa.me/message/GSQS5DHJT527K1`,
    analysis: {
      reason:
        "Anúncio de vagas de dermatologia com certificação e pagamento flexível, com links externos de contato e redes sociais, vaga legítima.",
      partner: null,
      category: "job_opportunity",
      confidence: 0.98,
      action: "allow",
    },
  },
  {
    text: `* *DERMATOLOGIA👩🏻‍⚕️*

🏥 *SEDE*
📍 _Alameda Santos, 2313 - 3° andar (esquina com a Haddock Lobo)_

        *\`DERMATOLOGIA\`*

📆 25/03 QUARTA FEIRA
⏰ 08:00 as 17:00

📆 08/04 QUARTA FEIRA
⏰ 08:00 as 17:00

📆 15/04 QUARTA FEIRA
⏰ 08:00 as 17:00


*✓ CERTIFICADO COM RQE*
*✓PAGAMENTO A VISTA OU FOLHA*

> Nos siga nas redes sociais
📷 instagram.com/medtrustservicosmedicos

🔗 medtrust.com.br

\`Entre em contato!\`

☎️📞📞
https://wa.me/5511913098896
https://wa.me/5511913098896
wa.me`,
    analysis: {
      reason:
        "Anúncio de vaga com local, datas, requisitos e forma de pagamento, vaga legítima; links para redes sociais são permitidos quando há vaga real.",
      partner: null,
      category: "job_opportunity",
      confidence: 1,
      action: "allow",
    },
  },
  {
    text: `📢 *DOAÇÃO ULTRASSOM PORTÁTIL* Prezados colegas, Meu nome é Bruna, sou médica cirurgiã. Recentemente, adquiri um aparelho de ultrassonografia portátil em um congresso brasileiro da área. Como já possuo um equipamento mais avançado, decidi disponibilizá-lo em doação para um colega que possa fazer bom uso do recurso na prática clínica. Acredito que o acesso a essa tecnologia pode contribuir bastante na assistência aos pacientes e na ampliação das possibilidades diagnósticas. 📩 Caso tenha interesse, entre em contato comigo no privado. Atenciosamente, Dra. Bruna`,
    analysis: {
      reason:
        "A mensagem fala sobre doação de equipamento e pede para chamar no privado — padrão típico de scam. Grupos não são feitos para doações.",
      partner: null,
      category: "scam",
      confidence: 1,
      action: "remove",
    },
  },
  {
    text: `💉 *VAGAS PARA ANESTESIOLOGIA - VÁRIAS REGIÕES - SP* 💉

💎 *MedPlantões - Captação Médica* 💎
Cod.: 00

*JORNAL DE VAGAS PARA MÉDICOS ANESTESISTAS

🏥*CIRURGIA CENTER HOSPITAL*🏥
_Avenida Ipiranga. 344 - Republica - SP_

*Anestesista*
Autorizam residentes

13/04 segunda das 08h-20h
17/04 sexta das 08h-20h
17/04 07:00 Procedimento: lifting + bléfaro sup + inf
20/04 segunda das 08h-20h
21/04 terça das 08h-20h
22/04 quarta das 08h-20h
23/04 quinta das 08h-20h
24/04 sexta das 08h-20h
29/04 quarta das 08h-20h
30/04 quinta das 08h-20h
————————
🏥*Hospital Beneficência Portuguesa*🏥
_Rua Maestro Cardim, 769, no bairro da Bela Vista, em São Paulo_
----------------------------------------------------
🏥*Hospital Maternidade Leonor Mendes de Barros*🏥
_Av. Celso Garcia, 2477 - Belenzinho, São Paulo - SP, 03015-000_

📌*Vagas Fixas*
Sexta noturno 2 vagas
Sábado 24hrs quinzenal 2 vagas
Domingo diurno 1 vaga
—————————————
*HOSPITAL MARCIA BRAIDO*
📍Endereço: R. Luís Louza, 48 - Santa Paula, São Caetano do⁷ Sul - SP,


🩺*ANESTESIA*
*RESIDÊNCIA CONCLUÍDA*

Segunda feira.
06/04 Diurno.
13/04 Diurno.

Terça-feira.
07/04 Diurno.
28/04 Diurno.

Quinta-feira.
02/04 Diurno.

Sexta-feira.
10/04 Diurno.
10/04 Diurno
17/04 Noturno.

R$ 2.000.

*Excelentes ganhos*
*Interessados chamar inbox*

*Faça seu cadastro e receba as melhores vagas no seu Email!*
🌐  🌐

☎ Caso tenha interesse nas vagas, entre em contato com um de nossos escalistas, links abaixo:

*Disponível das 06h30 às 21h00 (adm Juliana)*
https://wa.me/5511943670559

*Visite-nos no Linkedin*
🎦 https://www.linkedin.com/company/medplantoes 🎦

📋Abra ou feche sua empresa com a MedAssist - informações inbox📋
Business Account
ADMMP Juliana
https://wa.me/5511943670559`,
    analysis: {
      reason:
        "A mensagem divulga vagas de plantão médico. Apesar de oferecer serviços de intermediação, é classificada como oportunidade de trabalho.",
      partner: null,
      category: "job_opportunity",
      confidence: 1,
      action: "allow",
    },
  },
];
