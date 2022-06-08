import {
  CfnMapping,
  CfnOutput,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";

import {
  CfnGraphQLApi,
  CfnGraphQLSchema,
  CfnDataSource,
  CfnResolver,
  CfnFunctionConfiguration,
} from "aws-cdk-lib/aws-appsync";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  Table,
  AttributeType,
  BillingMode,
  StreamViewType,
  ProjectionType,
} from "aws-cdk-lib/aws-dynamodb";
import { readFileSync } from "fs";
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class CdkPipelineResolversStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    const userPool = new cognito.UserPool(this, "PipelineResolverUserPool", {
      selfSignUpEnabled: true,
      accountRecovery: cognito.AccountRecovery.PHONE_AND_EMAIL,
      userVerification: {
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
    });

    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool,
    });

    const dynamoDBRole = new Role(this, "DynamoDBRole", {
      assumedBy: new ServicePrincipal("appsync.amazonaws.com"),
    });

    dynamoDBRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonDynamoDBFullAccess")
    );

    // give appsync permission to log to cloudwatch by assigning a role

    const cloudWatchRole = new Role(this, "appSyncCloudWatchLogs", {
      assumedBy: new ServicePrincipal("appsync.amazonaws.com"),
    });

    cloudWatchRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AWSAppSyncPushToCloudWatchLogs"
      )
    );

    const graphAPI = new CfnGraphQLApi(this, "graphqlApi", {
      name: "sample-pipeline",
      authenticationType: "AMAZON_COGNITO_USER_POOLS",

      userPoolConfig: {
        userPoolId: userPool.userPoolId,
        defaultAction: "ALLOW",
        awsRegion: "us-east-2",
      },

      logConfig: {
        fieldLogLevel: "ALL",
        cloudWatchLogsRoleArn: cloudWatchRole.roleArn,
      },
      xrayEnabled: true,
    });

    const blockedUsersDynamoDBTable: Table = new Table(
      this,
      "BlockedUsersDynamoDBTable",
      {
        tableName: "BlockedUsersDynamoDBTable",

        partitionKey: {
          name: "userId",
          type: AttributeType.STRING,
        },
        sortKey: {
          name: "blockedUserId",
          type: AttributeType.STRING,
        },

        billingMode: BillingMode.PAY_PER_REQUEST,
        stream: StreamViewType.NEW_IMAGE,

        removalPolicy: RemovalPolicy.DESTROY,
      }
    );

    const postsDynamoDBTable: Table = new Table(this, "PostsDynamoDBTable", {
      tableName: "PostsDynamoDBTable",

      partitionKey: {
        name: "id",
        type: AttributeType.STRING,
      },

      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.NEW_IMAGE,

      removalPolicy: RemovalPolicy.DESTROY,
    });
    postsDynamoDBTable.addGlobalSecondaryIndex({
      indexName: "creator-index",
      partitionKey: {
        name: "creatorId",
        type: AttributeType.STRING,
      },

      projectionType: ProjectionType.ALL,
    });

    const postsTableDatasource: CfnDataSource = new CfnDataSource(
      this,
      "MyPostsDynamoDBTableDataSource",
      {
        apiId: graphAPI.attrApiId,
        name: "PostsDynamoDBTableDataSource",
        type: "AMAZON_DYNAMODB",
        dynamoDbConfig: {
          tableName: postsDynamoDBTable.tableName,
          awsRegion: this.region,
        },
        serviceRoleArn: dynamoDBRole.roleArn,
      }
    );

    const blockedUsersTableDatasource: CfnDataSource = new CfnDataSource(
      this,
      "MyBlockedUsersDynamoDBTableDataSource",
      {
        apiId: graphAPI.attrApiId,
        name: "BlockedUsersDynamoDBTableDataSource",
        type: "AMAZON_DYNAMODB",
        dynamoDbConfig: {
          tableName: blockedUsersDynamoDBTable.tableName,
          awsRegion: this.region,
        },
        serviceRoleArn: dynamoDBRole.roleArn,
      }
    );

    const apiSchema = new CfnGraphQLSchema(this, "GraphqlApiSchema", {
      apiId: graphAPI.attrApiId,
      definition: readFileSync("./schema/schema.graphql").toString(),
    });

    const createPostResolver = new CfnResolver(this, "CreatePostResolver", {
      apiId: graphAPI.attrApiId,
      typeName: "Mutation",
      fieldName: "createPost",

      dataSourceName: postsTableDatasource.name,
      requestMappingTemplate: readFileSync(
        "./lib/vtl_templates/create_post_request.vtl"
      ).toString(),
      responseMappingTemplate: readFileSync(
        "./lib/vtl_templates/create_post_response.vtl"
      ).toString(),
    });

    const blockUserResolver: CfnResolver = new CfnResolver(
      this,
      "BlockUserResolver",
      {
        apiId: graphAPI.attrApiId,
        typeName: "Mutation",
        fieldName: "blockUser",
        dataSourceName: blockedUsersTableDatasource.name,

        requestMappingTemplate: readFileSync(
          "./lib/vtl_templates/block_user_request.vtl"
        ).toString(),
        responseMappingTemplate: readFileSync(
          "./lib/vtl_templates/block_user_response.vtl"
        ).toString(),
      }
    );

    const isUserBlockedFunction: CfnFunctionConfiguration =
      new CfnFunctionConfiguration(this, "isUserBlockedFunction", {
        apiId: graphAPI.attrApiId,

        dataSourceName: blockedUsersTableDatasource.name,
        requestMappingTemplate: readFileSync(
          "./lib/vtl_templates/is_user_blocked_request.vtl"
        ).toString(),
        responseMappingTemplate: readFileSync(
          "./lib/vtl_templates/is_user_blocked_response.vtl"
        ).toString(),
        functionVersion: "2018-05-29",
        name: "isUserBlockedFunction",
      });

    const getPostsByCreatorFunction: CfnFunctionConfiguration =
      new CfnFunctionConfiguration(this, "getPostsByCreatorFunction", {
        apiId: graphAPI.attrApiId,
        dataSourceName: postsTableDatasource.name,
        requestMappingTemplate: readFileSync(
          "./lib/vtl_templates/get_posts_by_creator_request.vtl"
        ).toString(),

        responseMappingTemplate: readFileSync(
          "./lib/vtl_templates/get_posts_by_creator_response.vtl"
        ).toString(),

        functionVersion: "2018-05-29",
        name: "getPostsByCreatorFunction",
      });

    const getPostsByCreatorResolver: CfnResolver = new CfnResolver(
      this,
      "getPostsByCreatorResolver",
      {
        apiId: graphAPI.attrApiId,
        typeName: "Query",
        fieldName: "getPostsByCreator",
        kind: "PIPELINE",
        pipelineConfig: {
          functions: [
            isUserBlockedFunction.attrFunctionId,
            getPostsByCreatorFunction.attrFunctionId,
          ],
        },

        requestMappingTemplate: readFileSync(
          "./lib/vtl_templates/before_mapping_template.vtl"
        ).toString(),

        responseMappingTemplate: readFileSync(
          "./lib/vtl_templates/after_mapping_template.vtl"
        ).toString(),
      }
    );

    createPostResolver.addDependsOn(apiSchema);
    blockUserResolver.addDependsOn(apiSchema);
    getPostsByCreatorResolver.addDependsOn(apiSchema);

    new CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
    });

    new CfnOutput(this, "appsync id", {
      value: graphAPI.attrApiId,
    });
    new CfnOutput(this, "appsync Url", {
      value: graphAPI.attrGraphQlUrl,
    });

    new CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
  }
}
