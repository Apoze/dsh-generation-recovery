# dsh-generation-recovery

Politique native DSH de récupération des générations incomplètes et d'admission du contexte. Nécessite les points d'extension `agent/request-prepared` et `agent/response-incomplete` de la branche DSH `integration/dsh-0.1.5-rc.1-native`, basée sur `0.1.5-rc.1`. L'adaptateur `dsh-llm-ninfer` fournit les comptes et diagnostics ; la boucle DSH reste propriétaire de l'exécution et de la persistance.

## Activation

```yaml
- insert:
    - id: generation-recovery
      name: dsh-generation-recovery
      config:
        providers: [ninfer-local]
        maxRetries: 2
        maxTotalAttempts: 8
        maxCapacityRecoveries: 1
```

Le fork qualifié utilise Cordis `4.0.2`. Les peers doivent résoudre les paquets du fork compilé, y compris cette instance Cordis.

Monter une seule politique commune. Pour le profil Web, elle retrouve le compacteur isolé du preset via `agentPresets.serviceFor`. Les autres profils utilisent le service visible dans `agent.ctx`. Chaque compacteur concerné doit recevoir sa politique de modèle :

```yaml
modelPolicies:
  - provider: ninfer-local
    model: huihui-ai/Huihui-Qwen3.8-27B-abliterated-NInfer-NVFP4Full
    admission: prepared
    thresholdRatio: 0.7
    targetRatio: 0.4
    retainRatio: 0.25
    compactionRetries: 2
    summarizationReasoningEffort: low
    summarizationTools: false
    maxTokens: 32768
```

Les presets utilisateur dans `$DSH_HOME/.agent-presets` persistent lors d'une mise à jour. Les profils SDK ordinaires possèdent un compacteur global. Un profil minimal nécessite les services credentials, attachments, token-meter et compaction-basic ainsi qu'une compression de sessions compatible avec son stockage. Le patch Cordis remplace un objet `config` entier : conserver les autres champs obligatoires lorsqu'on modifie sa configuration.

## Comportement

La réserve vaut réflexion maximale + fermeture + 16 384 tokens de contenu (valeur de l'adaptateur). Le déclenchement est le plus petit du seuil préventif et de la capacité permettant cette réserve. À 60 % d'un contexte de 150 000 et avec une marge de 4 096, la génération dispose de 55 904 tokens. Elle n'est pas plafonnée à la différence avec 70 %.

Le compacteur réduit des plages équilibrées, valide son résumé, puis la requête est reconstruite et recomptée. Une réduction sans gain est bornée. Une entrée indivisible trop grande est refusée sans émission. Les annulations se propagent au compacteur et à la génération.

Après troncature, la tentative reste au journal mais ne rejoint pas le contexte comme réponse réussie. Le plugin ajoute une consigne technique persistante pour réaliser le travail par opérations natives plus petites. Il ne reconstitue pas les paramètres interrompus. Les outils déjà terminés ne sont pas relancés. Un texte en prose tronqué est régénéré sous forme complète plus courte ; il n'est pas concaténé automatiquement avec sa tentative inachevée.

Deux reprises au maximum, une seule correction de syntaxe invalide, et huit tentatives totales par pas, reprises réseau incluses. L'épuisement conserve une fin incomplète ou une erreur. Les compteurs proviennent du journal. Les anciennes réponses NInfer terminées sur `max-tokens` sans outils exécutés sont remplacées uniquement dans le contexte actif par une notice liée à leur événement original ; ce nettoyage est idempotent.

La fin normale atteste la terminaison du protocole et de la boucle. Elle ne garantit ni la qualité sémantique du code généré ni l'atomicité d'une tâche entière. Les outils natifs et leurs permissions restent responsables des effets.

## Tests réels du pipeline

```sh
npm run build
DSH_SOURCE=/chemin/vers/dsh-construit npm test
# Pour inclure le client Python :
DSH_SOURCE=/chemin/vers/dsh-construit DSH_TEST_PYTHON=/chemin/vers/python-avec-pydantic npm test
```

`DSH_NINFER_ADAPTER` peut désigner l'autre plugin, sinon il est recherché dans le dossier frère. Les tests démarrent de vrais processus DSH et un serveur HTTP local contrôlé, exécutent `write` dans un répertoire temporaire et lisent le fichier obtenu. Aucun credential utilisateur n'est lu. La simulation porte sur les réponses du fournisseur pour déclencher de façon déterministe des troncatures ; les essais GPU complémentaires valident le modèle réel.

Sous Windows, le test Python utilise un lanceur `dsh.cmd` temporaire vers Node et le CLI construit : Windows ne peut pas lancer directement le fichier JavaScript comme un exécutable.
