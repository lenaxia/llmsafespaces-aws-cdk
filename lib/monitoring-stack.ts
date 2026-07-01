import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface MonitoringStackProps extends cdk.StackProps {
  readonly postgres: rds.DatabaseInstance;
  readonly valkey: elasticache.CfnReplicationGroup;
  readonly clusterName: string;
  /** Monthly budget cap in USD. Above this: alarm to SNS. */
  readonly monthlyBudgetUsd: number;
  /** Email to notify on the AWS-managed budget alarm (belt & suspenders). */
  readonly budgetEmail: string;
}

/**
 * Cloud-side observability that doesn't need the cluster.
 *
 * Provides:
 *   - SNS topic (`alerts`) that routes to Slack + Pushover via Lambda
 *   - CloudWatch alarms on RDS, Valkey, ALB, cluster-independent AWS signals
 *   - AWS Budget alarm at the configured monthly threshold
 *
 * Cluster-side observability (Prometheus metrics, log aggregation, in-cluster
 * alerting) is handled by ops-prod's VictoriaMetrics + Alertmanager stack.
 * Both stacks funnel critical alerts to the same Slack+Pushover pair via a
 * SNS topic exposed here (Alertmanager posts to the topic via its SNS
 * receiver).
 *
 * Two secrets must exist in Secrets Manager, out-of-band:
 *   - `llmsafespaces/slack-webhook` — plain string, the Slack incoming
 *     webhook URL (e.g. `https://hooks.slack.com/services/T.../B.../...`)
 *   - `llmsafespaces/pushover` — JSON `{ "user_key": "...", "app_token": "..." }`
 *
 * Missing either is non-fatal at deploy time; the alert-router Lambda
 * simply skips the missing destination. Operator adds them via the AWS
 * console or CLI. Tagged with `llmsafespaces:role=alert-destination` so
 * the Lambda's IRSA policy can read them.
 */
export class MonitoringStack extends cdk.Stack {
  /** SNS topic that all alerts (cloud + cluster) post to. */
  public readonly alertsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    this.alertsTopic = this.buildAlertsTopic(props.budgetEmail);
    this.buildAlertRouterLambda();
    this.buildRdsAlarms(props.postgres);
    this.buildValkeyAlarms(props.valkey);
    this.buildBudgetAlarm(props.monthlyBudgetUsd, props.budgetEmail);
    this.buildEksAlarms(props.clusterName);
  }

  private buildAlertsTopic(email: string): sns.Topic {
    const topic = new sns.Topic(this, 'AlertsTopic', {
      displayName: 'llmsafespaces alerts',
    });
    // Email as a fallback subscription — belt & suspenders if the
    // Slack+Pushover Lambda breaks.
    topic.addSubscription(new snsSubs.EmailSubscription(email));
    return topic;
  }

  /**
   * Lambda subscribed to the alerts SNS topic. Reads the Slack webhook
   * URL and Pushover credentials from Secrets Manager at cold-start,
   * and forwards each SNS message to both destinations.
   *
   * Fault-tolerant: if either secret is missing or fetch fails, the
   * Lambda logs and continues with whichever destination worked.
   */
  private buildAlertRouterLambda(): void {
    // Secret placeholders — operator populates these out-of-band.
    // We create them so the Lambda can reference known ARNs; the value
    // remains empty (`{}`) until the operator sets it.
    const slackSecret = new secretsmanager.Secret(this, 'SlackWebhookSecret', {
      secretName: 'llmsafespaces/slack-webhook',
      description: 'Slack incoming webhook URL for alert routing. ' +
        'Set the SecretString to the raw webhook URL (starts with https://hooks.slack.com/...).',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    cdk.Tags.of(slackSecret).add('llmsafespaces:role', 'alert-destination');

    const pushoverSecret = new secretsmanager.Secret(this, 'PushoverSecret', {
      secretName: 'llmsafespaces/pushover',
      description: 'Pushover credentials for alert routing. ' +
        'Set the SecretString to JSON: {"user_key":"...","app_token":"..."}',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    cdk.Tags.of(pushoverSecret).add('llmsafespaces:role', 'alert-destination');

    // Inline Lambda code — small enough to keep here, avoids the CDK
    // Docker-in-Docker Lambda bundling overhead.
    const routerCode = `
import json
import os
import urllib.request
import urllib.error
import boto3

sm = boto3.client('secretsmanager')

def _get_secret(arn):
    try:
        resp = sm.get_secret_value(SecretId=arn)
        return resp.get('SecretString', '').strip()
    except Exception as e:
        print(f'WARN: could not fetch secret {arn}: {e}')
        return ''

SLACK_URL = _get_secret(os.environ['SLACK_SECRET_ARN'])
_pushover_raw = _get_secret(os.environ['PUSHOVER_SECRET_ARN'])
try:
    _pushover = json.loads(_pushover_raw) if _pushover_raw else {}
except json.JSONDecodeError:
    print(f'WARN: pushover secret is not JSON')
    _pushover = {}
PUSHOVER_USER = _pushover.get('user_key', '')
PUSHOVER_APP = _pushover.get('app_token', '')


def _post(url, data, headers=None):
    body = data if isinstance(data, bytes) else json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers=headers or {'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        print(f'ERR: HTTP {e.code} to {url}: {e.read()[:200]}')
    except Exception as e:
        print(f'ERR: request to {url}: {e}')
    return 0


def _format(record):
    # SNS record. Body is either a CloudWatch alarm JSON or a plain string.
    subject = record.get('Sns', {}).get('Subject') or 'llmsafespaces alert'
    message = record.get('Sns', {}).get('Message') or ''
    try:
        parsed = json.loads(message)
        if 'AlarmName' in parsed:
            alarm = parsed['AlarmName']
            state = parsed.get('NewStateValue', '?')
            reason = parsed.get('NewStateReason', '')
            return f'*{alarm}* {state}: {reason}'
    except json.JSONDecodeError:
        pass
    return f'*{subject}*: {message[:1500]}'


def handler(event, context):
    for record in event.get('Records', []):
        text = _format(record)
        if SLACK_URL:
            _post(SLACK_URL, {'text': text})
        if PUSHOVER_USER and PUSHOVER_APP:
            import urllib.parse
            _post(
                'https://api.pushover.net/1/messages.json',
                urllib.parse.urlencode({
                    'token': PUSHOVER_APP,
                    'user': PUSHOVER_USER,
                    'message': text,
                    'title': 'llmsafespaces',
                }).encode(),
                headers={'Content-Type': 'application/x-www-form-urlencoded'},
            )
    return {'ok': True}
`;

    const routerFn = new lambda.Function(this, 'AlertRouter', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(routerCode),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        SLACK_SECRET_ARN: slackSecret.secretArn,
        PUSHOVER_SECRET_ARN: pushoverSecret.secretArn,
      },
      description: 'Routes SNS alerts to Slack + Pushover',
    });

    // Grant read on the alert-destination secrets.
    routerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [slackSecret.secretArn, pushoverSecret.secretArn],
    }));

    // Subscribe Lambda to the SNS topic.
    this.alertsTopic.addSubscription(new snsSubs.LambdaSubscription(routerFn));

    new cdk.CfnOutput(this, 'SlackSecretArn', {
      value: slackSecret.secretArn,
      description: 'Set this SM secret to the Slack webhook URL',
    });
    new cdk.CfnOutput(this, 'PushoverSecretArn', {
      value: pushoverSecret.secretArn,
      description: 'Set this SM secret to JSON {"user_key":"...","app_token":"..."}',
    });
  }

  private buildRdsAlarms(postgres: rds.DatabaseInstance): void {
    const alarmAction = new cwActions.SnsAction(this.alertsTopic);

    new cw.Alarm(this, 'RdsCpuHigh', {
      metric: postgres.metricCPUUtilization({ period: cdk.Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cw.TreatMissingData.BREACHING,
      alarmDescription: 'RDS CPU >80% for 15 min',
      alarmName: 'llmsafespaces-rds-cpu-high',
    }).addAlarmAction(alarmAction);

    new cw.Alarm(this, 'RdsFreeStorageLow', {
      metric: postgres.metricFreeStorageSpace({ period: cdk.Duration.minutes(5) }),
      threshold: 5 * 1024 * 1024 * 1024, // 5 GiB
      comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      alarmDescription: 'RDS free storage < 5 GiB',
      alarmName: 'llmsafespaces-rds-storage-low',
    }).addAlarmAction(alarmAction);

    new cw.Alarm(this, 'RdsConnectionsHigh', {
      metric: postgres.metricDatabaseConnections({ period: cdk.Duration.minutes(5) }),
      // t4g.micro allows ~87 connections by default. Alarm at 70.
      threshold: 70,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      alarmDescription: 'RDS connections >70 for 15 min (near max)',
      alarmName: 'llmsafespaces-rds-connections-high',
    }).addAlarmAction(alarmAction);

    new cw.Alarm(this, 'RdsFreeMemoryLow', {
      metric: postgres.metricFreeableMemory({ period: cdk.Duration.minutes(5) }),
      threshold: 100 * 1024 * 1024, // 100 MiB
      comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      alarmDescription: 'RDS freeable memory < 100 MiB',
      alarmName: 'llmsafespaces-rds-memory-low',
    }).addAlarmAction(alarmAction);
  }

  private buildValkeyAlarms(valkey: elasticache.CfnReplicationGroup): void {
    const alarmAction = new cwActions.SnsAction(this.alertsTopic);
    // ElastiCache doesn't expose L2 metric helpers on CfnReplicationGroup.
    // Build metrics via the raw Metric construct.
    const metric = (name: string, unit: cw.Unit = cw.Unit.PERCENT) =>
      new cw.Metric({
        namespace: 'AWS/ElastiCache',
        metricName: name,
        dimensionsMap: {
          ReplicationGroupId: valkey.ref,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
        unit,
      });

    new cw.Alarm(this, 'ValkeyCpuHigh', {
      metric: metric('EngineCPUUtilization'),
      threshold: 80,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      alarmDescription: 'Valkey engine CPU >80% for 15 min',
      alarmName: 'llmsafespaces-valkey-cpu-high',
    }).addAlarmAction(alarmAction);

    new cw.Alarm(this, 'ValkeyMemoryHigh', {
      metric: metric('DatabaseMemoryUsagePercentage'),
      threshold: 80,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      alarmDescription: 'Valkey memory >80% for 15 min (evictions imminent)',
      alarmName: 'llmsafespaces-valkey-memory-high',
    }).addAlarmAction(alarmAction);

    new cw.Alarm(this, 'ValkeyEvictions', {
      metric: new cw.Metric({
        namespace: 'AWS/ElastiCache',
        metricName: 'Evictions',
        dimensionsMap: { ReplicationGroupId: valkey.ref },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 100, // arbitrary: any eviction is unusual; 100/5min is a real signal
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      alarmDescription: 'Valkey evicting keys (cache too small or leak)',
      alarmName: 'llmsafespaces-valkey-evictions',
    }).addAlarmAction(alarmAction);
  }

  private buildBudgetAlarm(monthlyUsd: number, email: string): void {
    // AWS Budget with two thresholds: 80% actual (warn), 100% forecast (page).
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'llmsafespaces-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: monthlyUsd,
          unit: 'USD',
        },
        costFilters: {
          // Optional: scope to tagged resources only. For now, alarm on
          // the whole account since infra costs are dominated by this
          // stack.
        },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: email },
            { subscriptionType: 'SNS', address: this.alertsTopic.topicArn },
          ],
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: email },
            { subscriptionType: 'SNS', address: this.alertsTopic.topicArn },
          ],
        },
      ],
    });

    // AWS Budget needs the SNS topic to allow budgets.amazonaws.com to
    // publish. Attach the resource policy.
    this.alertsTopic.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['sns:Publish'],
      principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
      resources: [this.alertsTopic.topicArn],
    }));
  }

  private buildEksAlarms(clusterName: string): void {
    const alarmAction = new cwActions.SnsAction(this.alertsTopic);
    // Control-plane logs go to CloudWatch Logs; we alarm on error log
    // counts as a proxy for cluster health. Metric filter counts lines
    // matching `panic|error|fatal` in the /aws/eks/{cluster}/cluster
    // log group.
    //
    // The log group is created by EKS when clusterLogging is enabled
    // (ClusterStack turns on API, AUDIT, AUTHENTICATOR types).
    const logGroup = logs.LogGroup.fromLogGroupName(
      this, 'EksControlPlaneLogs',
      `/aws/eks/${clusterName}/cluster`,
    );

    new logs.MetricFilter(this, 'EksErrorFilter', {
      logGroup,
      metricNamespace: 'llmsafespaces/eks',
      metricName: 'ControlPlaneErrors',
      filterPattern: logs.FilterPattern.anyTerm('panic', 'FATAL', '"level":"error"'),
      metricValue: '1',
      defaultValue: 0,
    });

    new cw.Alarm(this, 'EksControlPlaneErrors', {
      metric: new cw.Metric({
        namespace: 'llmsafespaces/eks',
        metricName: 'ControlPlaneErrors',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'EKS control plane logging >10 errors in 5 min',
      alarmName: 'llmsafespaces-eks-control-plane-errors',
    }).addAlarmAction(alarmAction);
  }
}
